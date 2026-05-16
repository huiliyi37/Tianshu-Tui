import type { ApiClient, StreamCallbacks } from '../api/client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { ToolRegistry } from '../tools/registry.js'
import { SessionContext } from './context.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { buildPrewarmValue } from './prewarm-file.js'
import { smartCompact } from '../compact/index.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { CACHE_ANCHOR_MESSAGES, type CompactionConfig } from '../compact/constants.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import { createContextLedger } from '../context/ledger.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import { AnchorRegistry } from '../context/anchor-registry.js'
import { claimProposalFromAnchor } from '../context/claims.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import { EvidenceTracker } from './evidence.js'
import { selectEvictionCandidates } from '../context/claim-budget.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import type { HookRegistry } from '../hooks/registry.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel } from './trace-store.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { ImportGraph } from './import-graph.js'
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { RepairHintTracker } from './repair-hint.js'
import type { PermissionConfig } from './permissions.js'
import { type ApprovalResult } from './approval-edit.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { extractTaskState } from './task-state.js'
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'
import { processTurnEnd } from './turn-end.js'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual'

export interface AgentConfig {
  client: ApiClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  compactClient?: ApiClient
  compactModel?: string
  approvalMode?: ApprovalMode
  sessionId?: string
  transcriptPath?: string
  getSessionMemoryState?: () => import('../context/types.js').LedgerSessionMemoryState | undefined
  hooks?: HookRegistry
  fileHistory?: import('./file-history.js').FileHistory
  modelCards?: ModelCapabilityCard[]
  onModelSwitch?: (newModel: string) => void
  getCurrentModel?: () => string
  autoReasoning?: boolean
  reasoningEffort?: import('./auto-reasoning.js').ReasoningEffort
  lspEnabled?: boolean
  permissions?: PermissionConfig
  contextClaimStore?: ContextClaimStore
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}

export class AgentLoop {
  private abortController: AbortController | null = null
  private cwd: string
  private evidence: EvidenceTracker
  private compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  private recentToolHistory: ToolHistoryEntry[] = []
  private prewarm = new PrewarmCache()
  private streamedText = ''
  private lastPrewarmAt = 0
  private latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  private decisions: string[] = []
  private trajectory = new TrajectoryRecorder()
  private repairPipeline = new RepairPipeline([fourHorsemenPass, semanticRepairPass])
  private repairHintTracker = new RepairHintTracker()
  private traceStore: TraceStore
  private harness: TurnHarness
  private routingMetrics = new RoutingMetricsCollector()
  private importGraph: ImportGraph | null = null
  private userAnchors: ContextAnchor[] = []
  private anchorRegistry = new AnchorRegistry(2_000)
  private lastConflictCheckCount = 0

  constructor(
    private config: AgentConfig,
    private session: SessionContext,
    cwd?: string,
  ) {
    this.cwd = cwd ?? process.cwd()
    this.evidence = new EvidenceTracker()
    this.traceStore = createTraceStore()
    this.harness = new TurnHarness(
      { maxRetries: 2, retryableClasses: ['timeout', 'flaky'] },
      this.trajectory,
    )
  }

  private recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string): void {
    const target = typeof input?.path === 'string'
      ? input.path
      : typeof input?.file_path === 'string'
        ? input.file_path
        : typeof input?.command === 'string'
          ? input.command.slice(0, 50)
          : name
    this.recentToolHistory.push({
      tool: name,
      target,
      status: isError ? 'failed' : 'success',
      error: isError ? result.slice(0, 50) : undefined,
    })
    if (this.recentToolHistory.length > 5) this.recentToolHistory.shift()
  }

  private maybePrewarm(text: string): void {
    const intents = extractIntents(text)
    for (const intent of intents) {
      if (intent.type !== 'file') continue
      const value = buildPrewarmValue(this.cwd, intent.value)
      if (!value) continue
      if (!this.prewarm.get(value.canonicalPath)) {
        this.prewarm.set(value.canonicalPath, value)
      }
    }
  }

  abort(): void {
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  getTrajectoryStats(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    return this.trajectory.summarize()
  }

  resetTrajectory(): void {
    this.trajectory.reset()
  }

  getTraceStore(): TraceStore { return this.traceStore }

  getEvidenceState() { return this.evidence.getState() }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' { return getDoomLoopLevel(this.traceStore.toolFingerprints) }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

  getLedger() { return this.session.getContextLedger() }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.userAnchors.push({ kind, text, sourceRoundIndex: -1, salience: 1.0 })
    this.refreshLedger()
  }

  getFileHistory() { return this.config.fileHistory }

  getDebugInfo() {
    const fp = this.config.promptEngine.getFingerprint()
    const drift = this.config.promptEngine.checkDrift()
    const sysPrompt = this.config.promptEngine.getSystemPrompt()
    return {
      fingerprint: fp,
      drift,
      systemPromptLength: sysPrompt.length,
      systemPromptPreview: sysPrompt.slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
      toolCount: this.config.toolRegistry.getDefinitions().length,
      toolNames: this.config.toolRegistry.getDefinitions().map(t => t.name),
    }
  }

  private async compactMessages(
    messages: Message[],
    tokenCount: number,
  ): Promise<{ messages: Message[] }> {
    if (this.config.compactClient && this.config.compactModel) {
      const result = await smartCompact(
        this.config.compactClient,
        messages,
        tokenCount,
        this.config.contextWindow,
        this.config.compactModel,
      )
      return { messages: result.messages }
    }
    return microCompact(messages, this.config.contextWindow, tokenCount)
  }

  private refreshLedger(): void {
    const ledger = createContextLedger(
      this.config.sessionId ?? 'session',
      this.config.transcriptPath ?? '',
      this.session.getMessages(),
      this.config.contextWindow,
      this.config.getSessionMemoryState?.(),
      this.userAnchors,
    )
    this.session.setContextLedger(ledger)
  }

  private recordUserInputClaims(userInput: string): void {
    if (!this.config.contextClaimStore || !this.config.sessionId) return

    const before = this.anchorRegistry.getAnchors().length
    const turn = this.session.getTurnCount()
    this.anchorRegistry.processUserMessage(userInput, turn)
    const anchors = this.anchorRegistry.getAnchors().slice(before)
    const createdAt = Date.now()

    for (const anchor of anchors) {
      const proposal = claimProposalFromAnchor(anchor, {
        actor: 'user',
        sessionId: this.config.sessionId,
        turn,
        eventId: `turn-${turn}:user-input`,
        createdAt,
      })
      this.config.contextClaimStore.propose(proposal)
    }
  }

  private refreshActiveClaims(): void {
    if (!this.config.contextClaimStore) {
      this.config.promptEngine.updateActiveClaims([])
      return
    }

    this.config.contextClaimStore.promoteEligibleClaims()
    const activeClaims = this.config.contextClaimStore.listActiveClaims()
    const usedAt = Date.now()
    const consumerId = `turn-${this.session.getTurnCount()}:prompt`
    for (const claim of activeClaims) {
      this.config.contextClaimStore.recordClaimUsed(claim.id, {
        consumerId,
        consumerKind: 'prompt',
        usedAt,
      })
    }

    // Budget eviction: mark excess low-value claims as stale
    const toEvict = selectEvictionCandidates(this.config.contextClaimStore.listActiveClaims())
    for (const c of toEvict) {
      this.config.contextClaimStore.updateClaimStatus(c.id, 'stale', 'budget eviction')
    }

    this.config.promptEngine.updateActiveClaims(this.config.contextClaimStore.listActiveClaims())
  }


  private enforceContextCeiling(): void {
    const ceiling = this.config.contextWindow * 0.95
    if (this.session.getEstimatedTokens() <= ceiling) return

    const messages = this.session.getMessages()
    const taskState = extractTaskState(this.trajectory.getEntries(), this.streamedText)
    const stateLines = [
      `Current: ${taskState.current}`,
      ...taskState.completed.map(item => `Completed: ${item}`),
      ...taskState.remaining.map(item => `Remaining: ${item}`),
    ]
    const anchorMessages = messages.slice(0, CACHE_ANCHOR_MESSAGES)
    let resumeMessage: Message = {
      role: 'user',
      content: `<checkpoint-resume>\n${stateLines.join('\n')}\n</checkpoint-resume>`,
    }
    let candidate = [...anchorMessages, resumeMessage]

    if (estimateTokens(candidate) > ceiling) {
      resumeMessage = {
        role: 'user',
        content: '<checkpoint-resume>Context ceiling exceeded. Continue from preserved cache anchors and ask for missing details if needed.</checkpoint-resume>',
      }
      candidate = [...anchorMessages, resumeMessage]
    }

    this.session.replaceMessages(candidate)
    this.session.recordCompactEvent({
      turn: this.session.getTurnCount(),
      tier: 4,
      reason: 'context ceiling exceeded; checkpoint-resume required',
      beforeTokens: estimateTokens(messages),
      afterTokens: this.session.getEstimatedTokens(),
      createdAt: Date.now(),
    })
    this.refreshLedger()
  }

  async run(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    this.abortController = new AbortController()
    this.trajectory.reset()
    this.decisions = []
    this.traceStore = createTraceStore()
    this.recordUserInputClaims(userInput)
    this.session.addUserMessage(userInput)

    if (this.config.autoReasoning) {
      this.config.reasoningEffort = selectReasoningEffort(userInput)
    }

    let checkpointCreatedThisTurn = false

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        const messages = this.session.getMessages()
        const estTokens = this.session.getEstimatedTokens()
        const compactDecision = decideCompactTier({
          estimatedTokens: estTokens,
          maxTokens: this.config.contextWindow,
          turn: this.session.getTurnCount(),
          failures: this.compactFailures,
        })
        if (compactDecision.shouldCompact) {
          const beforeTokens = estTokens
          try {
            const { messages: compacted } = await this.compactMessages(messages, estTokens)
            this.session.replaceMessages(compacted)
            this.session.markCompacted(turn)
            const afterTokens = this.session.getEstimatedTokens()
            this.session.recordCompactEvent({
              turn: this.session.getTurnCount(),
              tier: this.config.compactClient ? 2 : 1,
              reason: `auto compact: ${compactDecision.reason}`,
              beforeTokens,
              afterTokens,
              createdAt: Date.now(),
            })
            this.compactFailures = recordCompactSuccess(this.compactFailures)
            this.refreshLedger()
          } catch (err) {
            this.compactFailures = recordCompactFailure(this.compactFailures, this.session.getTurnCount())
            throw err
          }
        }

        this.streamedText = ''
        this.lastPrewarmAt = 0

        // Pass 5: adaptive repair hint injection
        const repairHint = this.repairHintTracker.getHint()
        this.config.promptEngine.setRepairHint(repairHint)

        this.enforceContextCeiling()
        this.refreshActiveClaims()
        const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
        const collectedBlocks: ContentBlock[] = []
        let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        const streamCallbacks: StreamCallbacks = {
          onTextDelta: (text) => {
            this.streamedText += text
            if (this.streamedText.length - this.lastPrewarmAt >= 500) {
              this.lastPrewarmAt = this.streamedText.length
              this.maybePrewarm(this.streamedText)
            }
            callbacks.onTextDelta(text)
          },
          onThinkingDelta: (thinking) => {
            callbacks.onThinkingDelta(thinking)
          },
          onContentBlock: (block) => {
            collectedBlocks.push(block)
            if (isToolUse(block)) {
              toolUses.push({ id: block.id, name: block.name, input: block.input })
              callbacks.onToolUse(block.id, block.name, block.input)
            }
          },
          onStopReason: (_reason, usage) => {
            this.session.addUsage(usage)
          },
          onError: (error) => {
            callbacks.onError(error)
          },
        }

        await this.config.client.stream(request, streamCallbacks, this.abortController.signal)

        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        if (collectedBlocks.length > 0) {
          this.session.addAssistantBlocks(collectedBlocks)
        }

        if (toolUses.length > 0) {
          const toolResults: ContentBlock[] = []

          for (const tu of toolUses) {
            const pipelineDeps: ToolPipelineDeps = {
              config: this.config,
              cwd: this.cwd,
              harness: this.harness,
              prewarm: this.prewarm,
              evidence: this.evidence,
              traceStore: this.traceStore,
              repairHintTracker: this.repairHintTracker,
              repairPipeline: this.repairPipeline,
              importGraph: this.importGraph,
              lastConflictCheckCount: this.lastConflictCheckCount,
              trajectory: this.trajectory,
              getDoomLoopLevel: () => this.getDoomLoopLevel(),
              latestRisk: this.latestRisk,
              sessionTurnCount: this.session.getTurnCount(),
              sessionId: this.config.sessionId,
              recordToolHistory: (name, input, isError, content) => this.recordToolHistory(name, input, isError, content),
            }

            const result = await executeToolUse(tu, pipelineDeps, callbacks, turn, checkpointCreatedThisTurn)

            this.traceStore = result.traceStore
            this.importGraph = result.importGraph
            this.lastConflictCheckCount = result.lastConflictCheckCount
            this.latestRisk = result.latestRisk
            if (result.checkpointCreated) checkpointCreatedThisTurn = true

            toolResults.push(result.toolResult)
          }

          this.session.addToolResults(toolResults)

          const turnEndResult = processTurnEnd({
            config: this.config,
            session: this.session,
            trajectory: this.trajectory,
            streamedText: this.streamedText,
            routingMetrics: this.routingMetrics,
            decisions: this.decisions,
            evidence: this.evidence,
          })
          this.decisions = turnEndResult.decisions
          this.refreshLedger()
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
          continue
        }

        const finalResult = processTurnEnd({
          config: this.config,
          session: this.session,
          trajectory: this.trajectory,
          streamedText: this.streamedText,
          routingMetrics: this.routingMetrics,
          decisions: this.decisions,
          evidence: this.evidence,
        })
        this.decisions = finalResult.decisions
        if (finalResult.badge) callbacks.onTextDelta('\n' + finalResult.badge)
        this.refreshLedger()
        callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
        this.evidence.reset()
        break
      }
    } catch (err) {
      if ((err as Error).name === 'AbortError') {
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    }
  }
}
