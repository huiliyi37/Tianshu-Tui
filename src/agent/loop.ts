import type { StreamCallbacks } from '../api/client.js'
import type { StreamClient } from '../api/stream-client.js'
import type { ContentBlock, Message, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { ToolRegistry } from '../tools/registry.js'
import { killAll } from '../tools/process-tracker.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { diagnoseCacheMiss } from '../prompt/cache-diagnostic.js'
import { batchPrewarm, buildPrewarmValue } from './prewarm-file.js'
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
import { ctclSanitizerPass } from './ctcl-sanitizer.js'
import { RepairHintTracker } from './repair-hint.js'
import type { PermissionConfig } from './permissions.js'
import { type ApprovalResult } from './approval-edit.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { extractTaskState } from './task-state.js'
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'
import { processTurnEnd } from './turn-end.js'
import { createPredictionAccumulator, recordPrediction, getInterventionLevel, shouldTippingPointReset, resetAccumulator, adjustReasoningEffort } from './prediction-error.js'
import type { PredictionAccumulator } from './prediction-error.js'
import { stripIntraTurnRepetition } from './dedup.js'
import { computeSensorium, computeStrategy } from './sensorium.js'
import type { Sensorium, SensoriumInput } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { getGitChangeRate, smoothChangeRate } from './git-freshness.js'
import { mapSensoriumToPhase, createStarEvent, createThetaState, tickTheta, completeTheta, advanceThetaCounter } from './star-event.js'
import type { StarEvent, ThetaState } from './star-event.js'
import { shouldKick, buildKickActions, shouldEscalateFromKick } from './dissipative-kick.js'
import { runThetaCheck } from './theta-check.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { StigmergyStore } from '../context/stigmergy.js'
import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'
import { ProviderHealthTracker } from './provider-health.js'
import { join } from 'node:path'

export type ApprovalMode = 'auto-accept' | 'auto-safe' | 'manual'

function mapQueriedPheromones(results: PheromoneQueryResult[]): Pheromone[] {
  return results.map(r => ({
    path: r.path,
    signal: r.signal,
    strength: r.currentStrength,
    depositedAt: r.depositedAt,
    halfLife: r.halfLife,
    ...(r.context ? { context: r.context } : {}),
  }))
}

export interface AgentConfig {
  client: StreamClient
  promptEngine: PromptEngine
  toolRegistry: ToolRegistry
  maxTurns: number
  contextWindow: number
  compact: CompactionConfig
  compactClient?: StreamClient
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
  /** Optional provider health tracker for Physarum-style routing.
   *  Degradation ratio affects sensorium stability dimension. */
  providerHealth?: ProviderHealthTracker
}

export interface AgentCallbacks {
  onTextDelta: (text: string) => void
  onThinkingDelta: (thinking: string) => void
  onToolUse: (id: string, name: string, input: Record<string, unknown>) => void
  onToolResult: (id: string, name: string, result: string, isError?: boolean, rawPath?: string, uiContent?: string) => void
  onTurnComplete: (usage: Partial<Usage>, turnNumber: number, isFinal?: boolean) => void
  onError: (error: Error) => void
  onAbort: () => void
  onApprovalRequired: (id: string, name: string, input: Record<string, unknown>) => Promise<ApprovalResult | boolean>
  onCheckpoint?: (hash: string) => void
  onPhaseChange?: (phase: string, detail?: { tool?: string; reason?: string; suggestion?: string }) => void
  /** Called to drain any pending steer guidance for injection into tool results */
  onSteerDrain?: () => string | null
}

function isToolUse(b: ContentBlock): b is ContentBlock & { type: 'tool_use'; id: string; name: string } {
  return b.type === 'tool_use'
}


function displayTextFingerprint(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

export class AgentLoop {
  private abortController: AbortController | null = null
  private cwd: string
  private evidence: EvidenceTracker
  private compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  private recentToolHistory: ToolHistoryEntry[] = []
  private prewarm = new PrewarmCache(60_000, 50)
  private streamedText = ''
  private thinkingOnlyRetries = 0
  private lastThinkingContent = ''
  private lastTurnTextFingerprint = ''
  private lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  private latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  private decisions: string[] = []
  private trajectory = new TrajectoryRecorder()
  private repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  private repairHintTracker = new RepairHintTracker()
  private traceStore: TraceStore
  private harness: TurnHarness
  private routingMetrics = new RoutingMetricsCollector()
  private importGraph: ImportGraph | null = null
  private userAnchors: ContextAnchor[] = []
  private anchorRegistry = new AnchorRegistry(2_000)
  private lastConflictCheckCount = 0
  private predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  private outputTokenEscalationCount = 0
  private static readonly MAX_OUTPUT_ESCALATION = 3
  private pressureMonitor: PressureMonitor
  private sensorium: Sensorium | null = null
  private strategy: StrategyProfile | null = null
  private thetaState: ThetaState = createThetaState(7)
  private stigmergyStore: StigmergyStore
  private loadedPheromones: Pheromone[] = []
  private gitChangeRate = 0
  private _hasEnteredHighComplexity = false

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
    this.pressureMonitor = new PressureMonitor(this.config.contextWindow)
    const pheromonesPath = join(this.cwd, '.rivet', 'pheromones.json')
    this.stigmergyStore = new StigmergyStore(pheromonesPath)
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
      if (!this.prewarm.has(value.canonicalPath)) {
        this.prewarm.set(value.canonicalPath, value)
      }
    }
  }

  private async prewarmRecentReads(): Promise<void> {
    const paths = this.recentToolHistory
      .filter(entry => entry.tool === 'read_file' && entry.status === 'success')
      .map(entry => entry.target)
    await batchPrewarm(this.cwd, paths, this.prewarm)
  }

  abort(): void {
    this.abortController?.abort()
    killAll()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  setReasoningEffort(effort: import('./auto-reasoning.js').ReasoningEffort): void {
    this.config.reasoningEffort = effort
    this.config.client.setReasoningEffort?.(effort)
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  getTrajectoryStats(): { totalTools: number; failures: number; retries: number; avgDurationMs: number } {
    return this.trajectory.summarize()
  }

  getTrajectoryEntries(): import('./trajectory.js').TrajectoryEntry[] {
    return this.trajectory.getEntries()
  }

  resetTrajectory(): void {
    this.trajectory.reset()
  }

  getTraceStore(): TraceStore { return this.traceStore }

  getEvidenceState() { return this.evidence.getState() }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' { return getDoomLoopLevel(this.traceStore.toolFingerprints) }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

  getPrewarmStats(): { hits: number; misses: number; hitRate: number } { return this.prewarm.stats() }

  getCacheDiagnostic(): string | null { return this.lastCacheDiagnostic }

  private refreshCacheDiagnostic(turn: number): void {
    const hitRate = this.session.getLatestTurnHitRate()
    if (hitRate !== null && hitRate < 0.8) {
      const diagnostic = diagnoseCacheMiss(
        this.session.getCacheHistory(),
        this.session.getTurnCount(),
        this.config.promptEngine.checkDrift(),
        this.session.wasCompactedAt(turn),
      )
      this.lastCacheDiagnostic = diagnostic?.message ?? null
      return
    }
    this.lastCacheDiagnostic = null
  }

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

  private recordTurnSnapshot(): void {
    if (!this.config.sessionId) return
    const persist = new SessionPersist(this.config.sessionId)
    persist.appendTurnSnapshot({
      turn: this.session.getTurnCount(),
      timestamp: Date.now(),
      messageCount: this.session.getMessages().length,
      estimatedTokens: this.session.getEstimatedTokens(),
    })
  }

  async run(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    this.abortController = new AbortController()
    this.trajectory.reset()
    this.decisions = []
    this.traceStore = createTraceStore()
    this.predictionAccumulator = createPredictionAccumulator()
    // Reset accumulations from previous run
    this.thinkingOnlyRetries = 0
    this.lastThinkingContent = ''
    this.lastTurnTextFingerprint = ''
    this.evidence.reset()
    this.repairHintTracker = new RepairHintTracker()
    this.userAnchors = []
    this.outputTokenEscalationCount = 0
    this.sensorium = null
    this.strategy = null
    this.thetaState = createThetaState(7)
    this.loadedPheromones = []
    this._hasEnteredHighComplexity = false
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.stigmergyStore.prune().catch(() => {})
    this.stigmergyStore.query().then(p => { this.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})
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
            this.pressureMonitor.recordCompaction(this.session.getTurnCount())
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
        await this.prewarmRecentReads()

        // ── Git freshness: file change rate (Zeitgeber signal) ──
        getGitChangeRate(this.cwd).then(rate => {
          this.gitChangeRate = smoothChangeRate(rate, this.gitChangeRate)
        }).catch(() => {})

        // ── StarFlow v2: Sensorium computation ──
        const pressureResult = this.pressureMonitor.check(estTokens, this.session.getTurnCount())
        const evidenceState = this.evidence.getState()
        const sensoriumInput: SensoriumInput = {
          predictionAcc: this.predictionAccumulator,
          pressureResult,
          evidenceState: {
            filesModified: evidenceState.filesModified.size,
            verifiedCount: evidenceState.verifications.filter(v => v.status === 'passed').length,
          },
          toolCallHistory: this.recentToolHistory.map(h => h.tool),
          pheromones: this.loadedPheromones,
          doomLevel: getDoomLoopLevel(this.traceStore.toolFingerprints),
          gitChangeRate: this.gitChangeRate,
        }
        this.sensorium = computeSensorium(sensoriumInput)

        // Provider health degradation → reduces stability
        // When providers fail, agent operational stability is genuinely reduced
        if (this.config.providerHealth) {
          const degRatio = this.config.providerHealth.getDegradationRatio()
          if (degRatio > 0) {
            this.sensorium = {
              ...this.sensorium,
              stability: this.sensorium.stability * (1 - 0.3 * degRatio),
            }
          }
        }

        this.strategy = computeStrategy(this.sensorium)

        // Track whether complexity ever reached high → enables contracting phase
        if (this.sensorium.complexity > 0.5) {
          this._hasEnteredHighComplexity = true
        }

        // Wire strategy → harness: reasoning effort, theta interval
        this.setReasoningEffort(this.strategy.reasoningEffort)
        // Theta interval is base (from strategy) modulated by git change rate.
        // Higher code volatility → more frequent cross-file consistency checks.
        // floor = 2 prevents over-sampling; ceiling = baseInterval.
        const baseInterval = this.strategy.thetaCycleInterval
        const gitMod = 1 - this.gitChangeRate * 0.5
        const adaptiveInterval = Math.max(2, Math.round(baseInterval * gitMod))
        this.thetaState = { ...this.thetaState, interval: adaptiveInterval }

        // Emit StarEvent via existing onPhaseChange callback
        const recentTools = this.recentToolHistory.map(h => h.tool)
        const isWriting = recentTools.some(t => t === 'write_file' || t === 'edit_file')
        const isRunningTests = recentTools.some(t => t === 'run_tests')
        const isFinalTurn = turn >= this.config.maxTurns - 1
        const starCtx = {
          turn: this.session.getTurnCount(),
          isWriting,
          isRunningTests,
          isFinalTurn,
          shouldEscalate: this.strategy.shouldEscalate,
          hasEnteredHighComplexity: this._hasEnteredHighComplexity,
        }
        const event = createStarEvent(this.sensorium, starCtx)
        if (callbacks.onPhaseChange) {
          callbacks.onPhaseChange(event.phase, {
            tool: event.glyph,
            suggestion: event.label,
          })
        }

        // Sensorium telemetry: append snapshot to debug JSONL (~/.rivet/sensorium.jsonl)
        const telemetryLine = JSON.stringify({
          ts: Date.now(),
          turn: this.session.getTurnCount(),
          phase: event.phase,
          ...this.sensorium,
          strategy: {
            reasoningEffort: this.strategy.reasoningEffort,
            shouldEscalate: this.strategy.shouldEscalate,
            thetaInterval: this.strategy.thetaCycleInterval,
          },
          gitChangeRate: this.gitChangeRate,
        })
        import('node:fs/promises').then(fs =>
          fs.appendFile(join(this.cwd, '.rivet', 'sensorium.jsonl'), telemetryLine + '\n', 'utf-8')
            .catch(() => {})
        )

        // Dissipative kick — stagnation breakthrough
        if (shouldKick(this.sensorium)) {
          const recentFailed = this.recentToolHistory
            .filter(h => h.status === 'failed')
            .map(h => h.target)
            .filter(Boolean)
          const kickActions = buildKickActions(this.sensorium, this.cwd, recentFailed)

          for (const path of kickActions.deadEndPaths) {
            this.stigmergyStore.deposit({ path, signal: 'dead-end', strength: 0.9 }).catch(() => {})
          }

          const fullMessage = kickActions.alternativeFrameworks.length > 0
            ? `${kickActions.injectedMessage}\n\n**替代框架：**\n${kickActions.alternativeFrameworks.map(f => `- ${f}`).join('\n')}`
            : kickActions.injectedMessage
          if (fullMessage) {
            this.session.addUserMessage(fullMessage)
          }
          if (shouldEscalateFromKick(this.sensorium) && callbacks.onPhaseChange) {
            callbacks.onPhaseChange('tianshu-encore', {
              reason: 'Dissipative kick: stagnation detected',
              suggestion: 'Escalate to stronger model or reframe the problem',
            })
          }
        }

        // Pass 5: adaptive repair hint injection
        const repairHint = this.repairHintTracker.getHint()
        this.config.promptEngine.setRepairHint(repairHint)

        this.enforceContextCeiling()
        this.refreshActiveClaims()
        const request = this.config.promptEngine.buildRequest(this.session.getMessages(), this.recentToolHistory)
        const collectedBlocks: ContentBlock[] = []
        let thinkingAccum = ''
        let toolUses: Array<{ id: string; name: string; input: Record<string, unknown> }> = []
        let stopReason = ''
        let turnDisplayBuffer = ''
        const streamCallbacks: StreamCallbacks = {
          onTextDelta: (text) => {
            this.streamedText += text
            if (this.streamedText.length - this.lastPrewarmAt >= 500) {
              this.lastPrewarmAt = this.streamedText.length
              this.maybePrewarm(this.streamedText)
            }
            turnDisplayBuffer += text
          },
          onThinkingDelta: (thinking) => {
            thinkingAccum += thinking
            callbacks.onThinkingDelta(thinking)
          },
          onContentBlock: (block) => {
            collectedBlocks.push(block)
            if (isToolUse(block)) {
              toolUses.push({ id: block.id, name: block.name, input: block.input })
              callbacks.onToolUse(block.id, block.name, block.input)
            }
          },
          onStopReason: (reason, usage) => {
            stopReason = reason
            this.session.addUsage(usage)
            if (usage.cache_read_input_tokens !== undefined || usage.cache_creation_input_tokens !== undefined) {
              this.session.recordTurnCache(turn, {
                input_tokens: usage.input_tokens ?? 0,
                output_tokens: usage.output_tokens ?? 0,
                cache_read_input_tokens: usage.cache_read_input_tokens ?? 0,
                cache_creation_input_tokens: usage.cache_creation_input_tokens ?? 0,
              })
            }
          },
          onError: (error) => {
            callbacks.onError(error)
          },
        }

        let streamError: Error | null = null
        try {
          await this.config.client.stream(request, streamCallbacks, this.abortController.signal)
        } catch (err) {
          // On stream error, estimate usage from collected content before propagating
          const estimatedOut = this.streamedText.length + collectedBlocks.reduce((s, b) => s + (b.type === 'text' ? (b as { text: string }).text.length : 0), 0)
          if (estimatedOut > 0) {
            this.session.addUsage({ output_tokens: Math.ceil(estimatedOut / 4) })
          }
          streamError = err as Error
        }

        const dedupedBuffer = stripIntraTurnRepetition(turnDisplayBuffer)
        const displayFingerprint = displayTextFingerprint(dedupedBuffer)
        if (dedupedBuffer && displayFingerprint !== this.lastTurnTextFingerprint) {
          callbacks.onTextDelta(dedupedBuffer)
        }
        this.lastTurnTextFingerprint = displayFingerprint

        if (this.abortController.signal.aborted) {
          // Estimate output usage from what was streamed before abort
          const estimatedOut = this.streamedText.length
          if (estimatedOut > 0) {
            this.session.addUsage({ output_tokens: Math.ceil(estimatedOut / 4) })
          }
          callbacks.onAbort()
          return
        }

        if (streamError) {
          if (collectedBlocks.length > 0) {
            this.session.addAssistantBlocks(collectedBlocks)
            this.recordTurnSnapshot()
          }
          callbacks.onError(streamError)
          return
        }

        if (collectedBlocks.length > 0) {
          this.session.addAssistantBlocks(collectedBlocks)
        }

        // Output token escalation: silently continue when model hits token limit
        if (stopReason === 'max_output_tokens' && toolUses.length === 0 && this.outputTokenEscalationCount < AgentLoop.MAX_OUTPUT_ESCALATION) {
          this.outputTokenEscalationCount++
          this.session.addUserMessage('Continue your response from where you left off.')
          continue
        }

        if (toolUses.length > 0) {
          const toolResults: ContentBlock[] = []

          for (const tu of toolUses) {
            if (this.abortController.signal.aborted) break

            const pipelineDeps: ToolPipelineDeps = {
              config: this.config,
              cwd: this.cwd,
              harness: this.harness,
              prewarm: this.prewarm,
              evidence: this.evidence,
              traceStore: this.traceStore,
              repairHintTracker: this.repairHintTracker,
              repairPipeline: this.repairPipeline,
              abortSignal: this.abortController.signal,
              importGraph: this.importGraph,
              lastConflictCheckCount: this.lastConflictCheckCount,
              trajectory: this.trajectory,
              getDoomLoopLevel: () => this.getDoomLoopLevel(),
              latestRisk: this.latestRisk,
              sessionTurnCount: this.session.getTurnCount(),
              sessionId: this.config.sessionId,
              recordToolHistory: (name, input, isError, content) => this.recordToolHistory(name, input, isError, content),
              getInterventionLevel: () => getInterventionLevel(this.predictionAccumulator),
              recordPrediction: (correct) => {
                this.predictionAccumulator = recordPrediction(this.predictionAccumulator, correct)
              },
            }

            const result = await executeToolUse(tu, pipelineDeps, callbacks, turn, checkpointCreatedThisTurn)

            this.traceStore = result.traceStore
            this.importGraph = result.importGraph
            this.lastConflictCheckCount = result.lastConflictCheckCount
            this.latestRisk = result.latestRisk
            if (result.checkpointCreated) checkpointCreatedThisTurn = true

            toolResults.push(result.toolResult)
          }

          // Inject steer guidance into last tool result if available
          const steerText = callbacks.onSteerDrain?.()
          if (steerText && toolResults.length > 0) {
            const lastResult = toolResults[toolResults.length - 1]!
            if (lastResult.type === 'tool_result') {
              const existing = typeof lastResult.content === 'string' ? lastResult.content : ''
              toolResults[toolResults.length - 1] = { ...lastResult, content: existing + '\n\n' + steerText }
            }
          }

          this.session.addToolResults(toolResults)

          // Cerebellar Loop: check intervention level and adjust reasoning
          const level = getInterventionLevel(this.predictionAccumulator)
          if (level !== 'none') {
            this.config.promptEngine.setCerebellarHint(`Prediction error rate elevated (${level}). Mental model may be stale — verify assumptions before proceeding.`)
          } else {
            this.config.promptEngine.setCerebellarHint(null)
          }

          // Theta-Gamma: advance counter, check if cross-file consistency check is due
          this.thetaState = advanceThetaCounter(this.thetaState)
          if (this.sensorium && this.sensorium.complexity > 0.5 && tickTheta(this.thetaState, turn)) {
            runThetaCheck(this.cwd).then(result => {
              for (const errFile of result.errors) {
                this.repairHintTracker.recordFailure(errFile, 'type_error')
              }
            }).catch(() => {})
            this.thetaState = completeTheta(this.thetaState)
          }

          // Auto-deposit pheromones from tool execution patterns
          const evidenceState = this.evidence.getState()
          for (const tu of toolUses) {
            if (tu.name === 'read_file') {
              const path = typeof tu.input?.file_path === 'string' ? tu.input.file_path : ''
              if (!path) continue
              const readCount = this.recentToolHistory.filter(
                h => h.tool === 'read_file' && h.target === path
              ).length
              if (readCount >= 3 && !this.recentToolHistory.some(
                h => (h.tool === 'write_file' || h.tool === 'edit_file') && h.target === path
              )) {
                this.stigmergyStore.deposit({ path, signal: 'entry-point', strength: 0.4 }).catch(() => {})
              }
            }
            if (tu.name === 'write_file' || tu.name === 'edit_file') {
              const path = typeof tu.input?.file_path === 'string' ? tu.input.file_path : ''
              if (!path) continue
              const hasPassed = evidenceState.verifications.some(v => v.status === 'passed')
              const hasFailed = evidenceState.verifications.some(v => v.status === 'failed')
              if (hasPassed) {
                this.stigmergyStore.deposit({ path, signal: 'well-tested', strength: 0.6 }).catch(() => {})
              }
              if (hasFailed) {
                this.stigmergyStore.deposit({ path, signal: 'fragile', strength: 0.8 }).catch(() => {})
              }
            }
            if (tu.name === 'bash') {
              const bashErrors = this.recentToolHistory.filter(
                h => h.tool === 'bash' && h.status === 'failed'
              ).length
              if (bashErrors >= 2) {
                const deadPath = typeof tu.input?.command === 'string'
                  ? tu.input.command.slice(0, 50) : 'bash-command'
                this.stigmergyStore.deposit({ path: deadPath, signal: 'dead-end', strength: 0.9 }).catch(() => {})
              }
            }
          }
          // Refresh loaded pheromones after deposition, preserving decay semantics.
          this.stigmergyStore.query().then(p => { this.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})
          if (shouldTippingPointReset(this.predictionAccumulator)) {
            this.predictionAccumulator = resetAccumulator(this.predictionAccumulator)
            this.config.promptEngine.setCerebellarHint(null)
          }
          if (this.config.autoReasoning && this.config.reasoningEffort) {
            this.config.reasoningEffort = adjustReasoningEffort(this.config.reasoningEffort, level)
          }

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
          this.refreshCacheDiagnostic(turn)
          this.recordTurnSnapshot()
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
          continue
        }

        // Thinking-only turn detection: model produced reasoning but no text or tool calls.
        // Auto-retry with "continue" prompt, but stop if thinking is looping (similar content).
        if (this.streamedText.length === 0 && collectedBlocks.length === 0 && this.thinkingOnlyRetries < 1) {
          // Detect repetition within this thinking block (e.g. same 100-char chunk repeats 3+ times)
          const midChunk = thinkingAccum.length > 400 ? thinkingAccum.slice(150, 250) : ''
          const repeatsInBlock = midChunk.length > 0 &&
            (thinkingAccum.split(midChunk).length - 1) >= 3

          const isLooping = (this.lastThinkingContent.length > 0 &&
            thinkingAccum.slice(0, 600) === this.lastThinkingContent.slice(0, 600)) ||
            repeatsInBlock

          if (isLooping) {
            // Thinking loop detected — don't retry, fall through to turn-end
          } else {
            this.lastThinkingContent = thinkingAccum
            this.thinkingOnlyRetries++
            // Specific prompt to break the thinking pattern and force direct output
            this.session.addUserMessage('Please respond directly without additional thinking. Just output your answer.')
            continue
          }
        }
        this.thinkingOnlyRetries = 0
        this.lastThinkingContent = ''

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
        this.refreshCacheDiagnostic(turn)
        this.recordTurnSnapshot()
        callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), true)
        this.evidence.reset()
        break
      }
    } catch (err) {
      this.evidence.reset()
      if ((err as Error).name === 'AbortError') {
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    }
  }
}
