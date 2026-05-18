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
import type { Sensorium, SensoriumInput } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { getGitChangeRate, smoothChangeRate } from './git-freshness.js'
import { mapSensoriumToPhase, createStarEvent, createThetaState } from './star-event.js'
import type { StarEvent, ThetaState } from './star-event.js'
import { runThetaCheck } from './theta-check.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookSnapshot } from './runtime-hooks.js'
import { createDefaultRuntimeHooks } from './create-runtime-hooks.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { adaptThetaInterval, buildStarPhaseContext, buildTelemetrySnapshot } from './perception.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { StigmergyStore } from '../context/stigmergy.js'
import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'
import { ProviderHealthTracker } from './provider-health.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import { buildIntentPreview, type IntentPreview, type IntentPreviewAction } from './intent-preview.js'
import { extractKeywords } from './playbook.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput, SensoriumEntry } from './retrospect.js'
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
  playbookStore?: PlaybookStore
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
  onIntentPreview?: (intent: IntentPreview) => Promise<IntentPreviewAction>
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
  private vigorState: VigorState = createVigorState()
  private runtimeHooks: RuntimeHookPipeline
  private thetaCheckInFlight = false
  private thetaTelemetry: { lastReason: string | null; lastDurationMs: number | null; lastErrorCount: number; lastTimedOut: boolean; requestedCount: number } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
  }
  private thetaState: ThetaState = createThetaState(7)
  private stigmergyStore: StigmergyStore
  private loadedPheromones: Pheromone[] = []
  private gitChangeRate = 0
  private telemetryWriter: TelemetryWriter
  private baselineFingerprint: PrefixFingerprint | null = null
  private _hasEnteredHighComplexity = false
  private intentPreviewShown = 0
  private sensoriumSnapshots: SensoriumEntry[] = []
  private currentPhase = 'unknown'

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
    this.telemetryWriter = createTelemetryWriter(this.cwd)
    this.runtimeHooks = new RuntimeHookPipeline(createDefaultRuntimeHooks({
      stigmergyDeposit: deposit => this.stigmergyStore.deposit(deposit),
      stigmergyQuery: () => this.stigmergyStore.query(),
      getEvidenceState: () => this.evidence.getState(),
      setLoadedPheromones: pheromones => { this.loadedPheromones = mapQueriedPheromones(pheromones) },
      getThetaState: () => this.thetaState,
      setThetaState: state => { this.thetaState = state },
      getPredictionAccumulator: () => this.predictionAccumulator,
      playbookStore: this.config.playbookStore,
      buildRetrospectInput: () => this.buildRetrospectInput(),
      getDoomLoopLevel: () => this.getDoomLoopLevel(),
    }))
    const pheromonesPath = join(this.cwd, '.rivet', 'pheromones.json')
    this.stigmergyStore = new StigmergyStore(pheromonesPath)
  }

  private buildRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
    return {
      cwd: this.cwd,
      turn: this.session.getTurnCount(),
      recentToolHistory: this.recentToolHistory.map(h => ({ tool: h.tool, status: h.status, target: h.target })),
      sensorium: this.sensorium,
      strategy: this.strategy,
      vigor: this.vigorState,
      gitChangeRate: this.gitChangeRate,
      ...extra,
    }
  }

  private buildRetrospectInput(): RetrospectInput {
    const evidenceState = this.evidence.getState()
    return {
      sensoriumEntries: this.sensoriumSnapshots,
      gitLog: [],
      toolEvents: this.traceStore.events
        .filter(e => e.kind === 'tool')
        .map(e => ({
          turn: e.turn,
          name: e.name,
          status: e.status === 'passed' ? 'passed' : 'failed',
        })),
      evidenceSummary: {
        filesModified: evidenceState.filesModified.size,
        verifiedCount: evidenceState.verifications.filter(v => v.status === 'passed').length,
      },
      pheromoneSignals: this.loadedPheromones.map(p => ({
        signal: p.signal,
        path: p.path,
        strength: p.strength,
      })),
    }
  }

  private refreshPlaybookLessons(userInput: string): void {
    if (!this.config.playbookStore) return
    const keywords = extractKeywords(`${userInput} ${this.recentToolHistory.map(h => `${h.tool} ${h.target}`).join(' ')}`, 12)
    const lessons = this.config.playbookStore.query(keywords, 3)
    this.config.promptEngine.updatePlaybookLessons(lessons)
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

  private requestThetaCheck(reason: string): void {
    if (this.thetaCheckInFlight) return
    this.thetaCheckInFlight = true
    this.thetaTelemetry = {
      ...this.thetaTelemetry,
      lastReason: reason,
      requestedCount: this.thetaTelemetry.requestedCount + 1,
    }
    runThetaCheck(this.cwd).then(result => {
      for (const errFile of result.errors) {
        this.repairHintTracker.recordFailure(errFile, 'type_error')
      }
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: result.durationMs,
        lastErrorCount: result.errors.length,
        lastTimedOut: result.timedOut,
      }
    }).catch(() => {
      this.thetaTelemetry = {
        ...this.thetaTelemetry,
        lastDurationMs: null,
        lastErrorCount: 0,
        lastTimedOut: false,
      }
    }).finally(() => {
      this.thetaCheckInFlight = false
    })
  }

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
    this.intentPreviewShown = 0
    this.sensoriumSnapshots = []
    this.currentPhase = 'unknown'
    // Capture baseline canonical prefix fingerprint for drift detection
    this.baselineFingerprint = this.config.promptEngine.getFingerprint()
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.stigmergyStore.prune().catch(() => {})
    this.stigmergyStore.query().then(p => { this.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})
    this.recordUserInputClaims(userInput)
    this.refreshPlaybookLessons(userInput)
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

            // Cache boundary detection: did compaction touch cache-anchored messages?
            if (messages.length >= CACHE_ANCHOR_MESSAGES && compacted.length >= CACHE_ANCHOR_MESSAGES) {
              const anchorTouched = messages[CACHE_ANCHOR_MESSAGES - 1]!.content !== compacted[CACHE_ANCHOR_MESSAGES - 1]!.content
              if (anchorTouched) {
                this.pressureMonitor.recordCompaction(this.session.getTurnCount()) // extra signal
              }
            }

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
        await this.runtimeHooks.runPreTurn(createRuntimeHookContext(this.buildRuntimeSnapshot({
          sensoriumInput,
          providerDegradationRatio: this.config.providerHealth?.getDegradationRatio() ?? 0,
        }), {
          setSensorium: sensorium => { this.sensorium = sensorium },
          setStrategy: strategy => { this.strategy = strategy },
          injectUserMessage: message => { this.session.addUserMessage(message) },
          emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
        }))

        if (!this.sensorium || !this.strategy) {
          throw new Error('Perception runtime hook did not produce sensorium and strategy')
        }
        const currentSensorium: Sensorium = this.sensorium
        let currentStrategy: StrategyProfile = this.strategy

        await this.runtimeHooks.runAfterPerception(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
          setStrategy: strategy => { this.strategy = strategy; currentStrategy = strategy },
          setVigor: vigor => { this.vigorState = vigor },
          requestThetaCheck: reason => { this.requestThetaCheck(reason) },
        }))

        // Track whether complexity ever reached high → enables contracting phase
        if (currentSensorium.complexity > 0.5) {
          this._hasEnteredHighComplexity = true
        }

        // Wire strategy → harness: reasoning effort, theta interval
        this.setReasoningEffort(currentStrategy.reasoningEffort)
        // Theta interval is base (from strategy) modulated by git change rate.
        // Higher code volatility → more frequent cross-file consistency checks.
        // floor = 2 prevents over-sampling; ceiling = baseInterval.
        const adaptiveInterval = adaptThetaInterval(currentStrategy.thetaCycleInterval, this.gitChangeRate)
        this.thetaState = { ...this.thetaState, interval: adaptiveInterval }

        // Emit StarEvent via existing onPhaseChange callback
        const recentTools = this.recentToolHistory.map(h => h.tool)
        const starCtx = buildStarPhaseContext({
          turn: this.session.getTurnCount(),
          maxTurns: this.config.maxTurns,
          recentTools,
          shouldEscalate: currentStrategy.shouldEscalate,
          hasEnteredHighComplexity: this._hasEnteredHighComplexity,
        })
        const event = createStarEvent(currentSensorium, starCtx)
        this.currentPhase = event.phase
        if (callbacks.onPhaseChange) {
          callbacks.onPhaseChange(event.phase, {
            tool: event.glyph,
            suggestion: event.label,
          })
        }

        if (callbacks.onIntentPreview && this.intentPreviewShown < 3) {
          const preview = buildIntentPreview({
            strategy: currentStrategy,
            vigor: this.vigorState,
            sensorium: currentSensorium,
            pheromones: this.loadedPheromones,
            thrashingSuggestion: pressureResult.suggestion ?? null,
            recentTargets: this.recentToolHistory.map(h => h.target).filter((target): target is string => Boolean(target)),
          })
          if (preview) {
            this.intentPreviewShown++
            const action = await callbacks.onIntentPreview(preview)
            if (action === 'veto') {
              await this.stigmergyStore.deposit({ path: preview.summary, signal: 'dead-end', strength: 0.9, context: 'intent veto' })
              this.session.addUserMessage('<intent-veto>User vetoed the previous plan. Re-plan from the nearest safe branch point before using tools.</intent-veto>')
              callbacks.onPhaseChange?.('intent-veto', { reason: 'user vetoed intent', suggestion: 're-plan before tool use' })
              callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
              continue
            }
            if (action === 'alternative') {
              this.session.addUserMessage('<intent-alternative>User requested an alternative path. Prefer a lower-risk option and explain the tradeoff before using tools.</intent-alternative>')
            }
          }
        }

        // Sensorium telemetry: append snapshot to debug JSONL (~/.rivet/sensorium.jsonl)
        const currentFP = this.config.promptEngine.getFingerprint()
        const driftEvent = this.baselineFingerprint
          ? (currentFP.combinedSha256 !== this.baselineFingerprint.combinedSha256)
          : false
        const telemetrySnapshot = buildTelemetrySnapshot({
          ts: Date.now(),
          turn: this.session.getTurnCount(),
          phase: event.phase,
          sensorium: currentSensorium,
          strategy: currentStrategy,
          vigor: this.vigorState,
          theta: {
            inFlight: this.thetaCheckInFlight,
            lastReason: this.thetaTelemetry.lastReason,
            lastDurationMs: this.thetaTelemetry.lastDurationMs,
            lastErrorCount: this.thetaTelemetry.lastErrorCount,
            lastTimedOut: this.thetaTelemetry.lastTimedOut,
            requestedCount: this.thetaTelemetry.requestedCount,
          },
          gitChangeRate: this.gitChangeRate,
          prefixDrift: driftEvent,
        })
        this.telemetryWriter.write(telemetrySnapshot)
        this.sensoriumSnapshots.push({
          ts: telemetrySnapshot.ts,
          turn: telemetrySnapshot.turn,
          phase: telemetrySnapshot.phase,
          momentum: telemetrySnapshot.momentum,
          pressure: telemetrySnapshot.pressure,
          confidence: telemetrySnapshot.confidence,
          complexity: telemetrySnapshot.complexity,
          freshness: telemetrySnapshot.freshness,
          stability: telemetrySnapshot.stability,
          strategy: telemetrySnapshot.strategy,
          gitChangeRate: telemetrySnapshot.gitChangeRate,
        })


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

          for (const tu of toolUses) {
            const result = toolResults.find(r => r.type === 'tool_result' && r.tool_use_id === tu.id)
            const target = typeof tu.input?.file_path === 'string'
              ? tu.input.file_path
              : typeof tu.input?.path === 'string'
                ? tu.input.path
                : typeof tu.input?.command === 'string'
                  ? tu.input.command.slice(0, 50)
                  : undefined
            await this.runtimeHooks.runPostTool(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
              setVigor: vigor => { this.vigorState = vigor },
              requestThetaCheck: reason => { this.requestThetaCheck(reason) },
            }), {
              name: tu.name,
              success: !(result && 'is_error' in result && result.is_error === true),
              isError: result && 'is_error' in result ? result.is_error === true : false,
              target,
            })
          }

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
          await this.runtimeHooks.runPostTurn(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
            emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
          }))
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
        await this.runtimeHooks.runPostTurn(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
          emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
        }))
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
