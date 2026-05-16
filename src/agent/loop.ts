import type { ApiClient, StreamCallbacks } from '../api/client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { ToolRegistry } from '../tools/registry.js'
import type { ToolCallParams } from '../tools/types.js'
import { SessionContext } from './context.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { buildPrewarmValue, canUsePrewarmForRead } from './prewarm-file.js'
import { validatePath } from '../tools/path-validate.js'
import { smartCompact } from '../compact/index.js'
import { microCompact, estimateTokens } from '../compact/micro.js'
import { CACHE_ANCHOR_MESSAGES, type CompactionConfig } from '../compact/constants.js'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../context/compact-policy.js'
import { createContextLedger } from '../context/ledger.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import { EvidenceTracker } from './evidence.js'
import { createCheckpoint, recordAgentTouchedFile } from './checkpoint.js'
import { classifyFailure, classifyTestRun } from './failure-classifier.js'
import { extractTaskState } from './task-state.js'
import { detectMirror } from './behavior-mirror.js'
import { extractDecisions } from './decision-anchor.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import type { HookRegistry } from '../hooks/registry.js'
import { createTraceStore, startTraceEvent, finishTraceEvent, fingerprintToolCall, recordToolFingerprint, recordTraceEvent, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel } from './trace-store.js'
import { assessToolRisk } from './approval-risk.js'
import { suggestStrategyShift, type TrajectorySummary } from './strategy-shift.js'
import { inferTaskType } from '../model/task-inferrer.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import { recommendModelForTask, type ModelCapabilityCard } from '../model/capability.js'
import { buildImportGraph, invalidateFile, type ImportGraph } from './import-graph.js'
import { generateImpactHint } from './impact-hint.js'
import { RepairPipeline, summarizeRepairTelemetry } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { RepairHintTracker } from './repair-hint.js'
import { isToolAllowed, type PermissionConfig } from './permissions.js'
import { type ApprovalResult, applyApprovalEdit } from './approval-edit.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { shouldRunDiagnostics, runTypeCheck } from '../lsp/client.js'

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
            const params: ToolCallParams = {
              input: tu.input,
              toolUseId: tu.id,
              cwd: this.cwd,
              onOutput: (chunk) => {
                callbacks.onToolResult(tu.id, tu.name, chunk)
              },
            }
            try {
              // PreToolUse hook — can modify input or block execution
              const preHookResult = this.config.hooks?.firePreToolUse({ toolName: tu.name, input: tu.input as Record<string, unknown> }) ?? {}
              if (preHookResult.block) {
                const blockMsg = `Tool blocked by hook: ${preHookResult.reason ?? 'no reason given'}`
                callbacks.onToolResult(tu.id, tu.name, blockMsg, true)
                toolResults.push({ type: 'tool_result', tool_use_id: tu.id, content: blockMsg, is_error: true })
                continue
              }
              if (preHookResult.input) {
                tu.input = preHookResult.input
                params.input = preHookResult.input
              }

              // Multi-pass tool input repair
              const toolDef = this.config.toolRegistry.get(tu.name)
              if (toolDef) {
                const repairResult = this.repairPipeline.run(
                  tu.input as Record<string, unknown>,
                  { toolName: tu.name, schema: toolDef.definition.input_schema },
                )
                if (repairResult.telemetry.length > 0) {
                  tu.input = repairResult.output
                  params.input = repairResult.output
                  const repairSummary = summarizeRepairTelemetry(repairResult.telemetry)
                  if (repairSummary) {
                    const now = Date.now()
                    this.traceStore = recordTraceEvent(this.traceStore, {
                      id: `${tu.id}:repair`,
                      turn,
                      kind: 'tool',
                      name: `${tu.name}:repair`,
                      status: 'passed',
                      startedAt: now,
                      endedAt: now,
                      durationMs: 0,
                      summary: repairSummary,
                    })
                  }
                }
              }

              const trajectorySummary: TrajectorySummary[] = this.trajectory.getEntries().map(e => ({
                tool: e.tool,
                target: e.target,
                status: e.status === 'retried-failed' || e.status === 'failed' ? 'failed' : 'success',
                errorClass: e.errorClass,
              }))
              const doomLevel = this.getDoomLoopLevel()
              const hint = suggestStrategyShift(trajectorySummary, doomLevel)
              this.config.promptEngine.setStrategyShift(hint)
              if (doomLevel === 'blocked') {
                const msg = hint ?? 'Tool execution blocked: repeated identical failures detected. Change strategy before retrying.'
                callbacks.onToolResult(tu.id, tu.name, msg, true)
                toolResults.push({
                  type: 'tool_result',
                  tool_use_id: tu.id,
                  content: msg,
                  is_error: true,
                })
                continue
              }

              const needsApproval = this.config.toolRegistry.needsApproval(tu.name, params)
              const risk = assessToolRisk(tu.name, tu.input, this.getDoomLoopLevel())
              this.latestRisk = risk
              const isHighRisk = risk.level === 'high'
              const approvalMode = this.config.approvalMode ?? 'manual'

              const allowlisted = isToolAllowed(tu.name, tu.input, this.config.permissions?.allow)
              const shouldAsk = allowlisted
                ? false
                : approvalMode === 'manual'
                  ? needsApproval
                  : approvalMode === 'auto-safe'
                    ? isHighRisk
                    : false // auto-accept: never ask

              if (shouldAsk) {
                const approvalResult = await callbacks.onApprovalRequired(tu.id, tu.name, tu.input)
                const resolved: ApprovalResult = typeof approvalResult === 'boolean'
                  ? { approved: approvalResult }
                  : approvalResult
                const finalInput = applyApprovalEdit(tu.input, resolved)
                if (!finalInput) {
                  const denyMsg = 'Tool execution denied: requires user approval'
                  callbacks.onToolResult(tu.id, tu.name, denyMsg, true)
                  toolResults.push({
                    type: 'tool_result',
                    tool_use_id: tu.id,
                    content: denyMsg,
                    is_error: true,
                  })
                  continue
                }
                if (finalInput !== tu.input) {
                  tu.input = finalInput
                  params.input = finalInput
                }
              }

              if ((tu.name === 'write_file' || tu.name === 'edit_file') && !checkpointCreatedThisTurn) {
                const cp = await createCheckpoint(this.cwd, 'auto', this.config.sessionId)
                checkpointCreatedThisTurn = true
                if (cp) callbacks.onCheckpoint?.(cp.hash)
              }

              if ((tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
                recordAgentTouchedFile(this.cwd, tu.input.file_path, this.config.sessionId)
              }

              if (this.config.fileHistory && (tu.name === 'write_file' || tu.name === 'edit_file') && typeof tu.input.file_path === 'string') {
                await this.config.fileHistory.trackEdit(tu.input.file_path, tu.id)
              }

              // Execute via TurnHarness (retry + trajectory recording)
              const traceId = tu.id
              this.traceStore = startTraceEvent(this.traceStore, {
                id: traceId,
                turn,
                kind: 'tool',
                name: tu.name,
                startedAt: Date.now(),
                summary: JSON.stringify(tu.input).slice(0, 60),
              })
              let rawToolResult: import('../tools/types.js').ToolResult | undefined
              const harnessResult = await this.harness.executeTool({
                id: tu.id,
                name: tu.name,
                input: tu.input,
                turn,
                execute: async () => {
                  // Prewarm cache fast-path for read_file (canonical full-file only)
                  if (tu.name === 'read_file' && canUsePrewarmForRead(tu.input)) {
                    try {
                      const canonicalPath = validatePath(this.cwd, tu.input.file_path as string)
                      const cached = this.prewarm.get(canonicalPath)
                      if (cached) {
                        rawToolResult = { content: cached.content, uiContent: cached.uiContent }
                        return { content: cached.content }
                      }
                    } catch {
                      // Fall through to the real tool so it can return the standard error.
                    }
                  }
                  const r = await this.config.toolRegistry.execute(tu.name, params)
                  rawToolResult = r
                  return { content: r.content, isError: r.isError }
                },
                classify: (content) => classifyFailure(content).class,
                isConcurrencySafe: toolDef?.isConcurrencySafe() ?? false,
              })

              // PostToolUse hook — can modify result
              const postHookResult = this.config.hooks?.firePostToolUse({
                toolName: tu.name,
                input: tu.input as Record<string, unknown>,
                result: harnessResult.content,
                isError: harnessResult.isError,
              }) ?? {}
              let finalContent = postHookResult.result ?? harnessResult.content

              // LSP diagnostics after successful TS/JS file edits
              if (this.config.lspEnabled && !harnessResult.isError && shouldRunDiagnostics(tu.name, tu.input.file_path as string | undefined)) {
                const check = runTypeCheck(this.cwd, tu.input.file_path as string)
                if (check.formatted) {
                  finalContent = finalContent + `

[LSP Diagnostics]
${check.formatted}`
                }
              }

              this.traceStore = finishTraceEvent(this.traceStore, traceId, {
                status: harnessResult.isError ? 'failed' : 'passed',
                endedAt: Date.now(),
                summary: harnessResult.content.slice(0, 100),
              })
              const fp = fingerprintToolCall(tu.name, tu.input, harnessResult.isError ? 'error' : 'success')
              this.traceStore = recordToolFingerprint(this.traceStore, fp)

              callbacks.onToolResult(tu.id, tu.name, finalContent, harnessResult.isError, rawToolResult?.rawPath, rawToolResult?.uiContent)

              // Record tool history for volatile context injection
              this.recordToolHistory(tu.name, tu.input, harnessResult.isError, harnessResult.content)

              if (!harnessResult.isError) {
                this.repairHintTracker.recordSuccess(tu.name)
                this.config.promptEngine.setStrategyShift(null)
              } else {
                const failureClass = classifyFailure(harnessResult.content)
                this.repairHintTracker.recordFailure(tu.name, failureClass.class)
              }

              // Invalidate prewarm cache after writes (canonical path)
              if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError && typeof tu.input.file_path === 'string') {
                try {
                  this.prewarm.invalidate(validatePath(this.cwd, tu.input.file_path as string))
                } catch {
                  this.prewarm.invalidate(tu.input.file_path as string)
                }
              }

              if (tu.name === 'read_file' && !harnessResult.isError) {
                this.evidence.trackFileRead(tu.input.file_path as string)
              } else if ((tu.name === 'write_file' || tu.name === 'edit_file') && !harnessResult.isError) {
                this.evidence.trackFileModified(tu.input.file_path as string)
                // Impact hint from import graph
                if (!this.importGraph) {
                  this.importGraph = buildImportGraph(this.cwd)
                }
                if (this.importGraph) {
                  this.importGraph = invalidateFile(this.importGraph, this.cwd, tu.input.file_path as string)
                  const hint = generateImpactHint(this.importGraph, tu.input.file_path as string, this.cwd)
                  if (hint) {
                    this.evidence.trackImpact(hint.impactedFiles, hint.relatedTests)
                    this.config.promptEngine.setImpactHint(hint.summary)
                  }
                }
              } else if (tu.name === 'run_tests' && rawToolResult) {
                if (rawToolResult.verification) {
                  this.evidence.trackVerification(rawToolResult.verification)
                }
                if (rawToolResult.verification && rawToolResult.verification.status !== 'passed') {
                  const failures = classifyTestRun(harnessResult.content)
                  if (failures.length > 0 && failures[0]!.confidence >= 0.7) {
                    toolResults.push({
                      type: 'tool_result',
                      tool_use_id: tu.id,
                      content: `${finalContent}\n\nDiagnosis: ${failures[0]!.suggestion}`,
                      is_error: harnessResult.isError,
                    })
                    continue
                  }
                }
              }

              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: finalContent,
                is_error: harnessResult.isError,
              })
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err)
              this.repairHintTracker.recordFailure(tu.name, classifyFailure(msg).class)
              callbacks.onToolResult(tu.id, tu.name, msg, true)
              toolResults.push({
                type: 'tool_result',
                tool_use_id: tu.id,
                content: msg,
                is_error: true,
              })
            }
          }

          this.session.addToolResults(toolResults)

          // Extract task-state and inject into volatile context (after warmup turns)
          if (this.session.getTurnCount() > 3) {
            const taskState = extractTaskState(this.trajectory.getEntries(), this.streamedText)
            this.config.promptEngine.setTaskProgress(taskState)
          }

          // Behavior mirror detection (after warmup turns)
          const mirror = this.session.getTurnCount() > 3
            ? detectMirror(this.trajectory.getEntries())
            : null
          this.config.promptEngine.setBehaviorMirror(mirror)

          // Model routing: infer task type and potentially switch model
          if (this.config.modelCards && this.config.modelCards.length > 1 && this.config.getCurrentModel) {
            const currentModel = this.config.getCurrentModel()
            const recentCalls = this.trajectory.getEntries().slice(-10).map(e => ({
              name: e.tool,
              isError: e.status === 'failed' || e.status === 'retried-failed',
            }))
            const inference = inferTaskType(recentCalls)
            if (inference) {
              const recommended = recommendModelForTask(inference.task, this.config.modelCards)
              this.config.promptEngine.setRoutingReason(`${inference.task} · ${recommended.model} ${inference.reason}`)
              if (recommended.model !== currentModel && this.config.onModelSwitch) {
                this.routingMetrics.record({
                  turn: this.session.getTurnCount(),
                  inferredTask: inference.task,
                  recommendedModel: recommended.model,
                  currentModel,
                  switched: true,
                  reason: inference.reason,
                  timestamp: Date.now(),
                })
                try {
                  this.config.onModelSwitch(recommended.model)
                } catch { /* model switch failure is non-fatal */ }
              }
            }
          }

          this.refreshLedger()
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount())
          continue
        }

        // Extract decisions from model output
        const newDecisions = extractDecisions(this.streamedText)
        for (const d of newDecisions) {
          if (!this.decisions.includes(d)) this.decisions.push(d)
        }
        if (this.decisions.length > 3) this.decisions = this.decisions.slice(-3)
        this.config.promptEngine.setDecisions(this.decisions)

        const badge = this.evidence.buildBadge()
        if (badge) callbacks.onTextDelta('\n' + badge)
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
