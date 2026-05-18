import type { StreamCallbacks } from '../api/client.js'
import type { StreamClient } from '../api/stream-client.js'
import type { ContentBlock, Usage } from '../api/types.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { ToolRegistry } from '../tools/registry.js'
import { killAll } from '../tools/process-tracker.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm, buildPrewarmValue } from './prewarm-file.js'
import { type CompactionConfig } from '../compact/constants.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import { EvidenceTracker } from './evidence.js'
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
import { executeToolUse, type ToolPipelineDeps } from './tool-pipeline.js'
import { processTurnEnd } from './turn-end.js'
import { createPredictionAccumulator, recordPrediction, getInterventionLevel, shouldTippingPointReset, resetAccumulator, adjustReasoningEffort } from './prediction-error.js'
import type { PredictionAccumulator } from './prediction-error.js'
import { stripIntraTurnRepetition } from './dedup.js'
import type { Sensorium } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { getGitChangeRate, smoothChangeRate } from './git-freshness.js'
import { createThetaState } from './star-event.js'
import type { ThetaState } from './star-event.js'
import { runThetaCheck } from './theta-check.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookSnapshot } from './runtime-hooks.js'
import { createDefaultRuntimeHooks } from './create-runtime-hooks.js'
import { TurnPerceptionController } from './turn-perception.js'
import { TurnIntentController } from './turn-intent.js'
import { ContextInjectionController } from './context-injection.js'
import { CompactionController } from './compaction-controller.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { StigmergyStore } from '../context/stigmergy.js'
import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'
import { ProviderHealthTracker } from './provider-health.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { IntentPreview, IntentPreviewAction } from './intent-preview.js'
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
  runtimeHooks?: RuntimeHookPipeline
  fileHistory?: import('./file-history.js').FileHistory
  modelCards?: ModelCapabilityCard[]
  onModelSwitch?: (newModel: string) => void
  getCurrentModel?: () => string
  autoReasoning?: boolean
  reasoningEffort?: import('./auto-reasoning.js').ReasoningEffort
  reasoningFloor?: import('./auto-reasoning.js').ReasoningEffort
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
  private lastConflictCheckCount = 0
  private predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  private outputTokenEscalationCount = 0
  private static readonly MAX_OUTPUT_ESCALATION = 3
  private pressureMonitor: PressureMonitor
  private sensorium: Sensorium | null = null
  private strategy: StrategyProfile | null = null
  private vigorState: VigorState = createVigorState()
  private runtimeHooks: RuntimeHookPipeline
  private perception: TurnPerceptionController
  private intent: TurnIntentController
  private contextInjection: ContextInjectionController
  private compaction: CompactionController
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
    const pheromonesPath = join(this.cwd, '.rivet', 'pheromones.json')
    this.stigmergyStore = new StigmergyStore(pheromonesPath)
    this.runtimeHooks = this.config.runtimeHooks ?? new RuntimeHookPipeline(createDefaultRuntimeHooks({
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
      telemetryWriter: this.telemetryWriter,
      ...(this.config.sessionId ? {
        dream: {
          cwd: this.cwd,
          sessionId: this.config.sessionId,
          getDecisions: () => this.decisions,
          getTrajectory: () => this.trajectory.getEntries(),
        },
      } : {}),
    }))
    this.perception = new TurnPerceptionController({
      cwd: this.cwd,
      maxTurns: this.config.maxTurns,
      runtimeHooks: this.runtimeHooks,
      telemetryWriter: this.telemetryWriter,
      getRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      getProviderDegradationRatio: () => this.config.providerHealth?.getDegradationRatio() ?? 0,
      addUserMessage: message => { this.session.addUserMessage(message) },
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      setReasoningEffort: effort => { this.setReasoningEffort(effort) },
      getFingerprint: () => this.config.promptEngine.getFingerprint(),
    })
    this.intent = new TurnIntentController({
      depositDeadEnd: deposit => this.stigmergyStore.deposit(deposit),
      addUserMessage: message => { this.session.addUserMessage(message) },
    })
    this.contextInjection = new ContextInjectionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      getSessionId: () => this.config.sessionId,
      getTranscriptPath: () => this.config.transcriptPath,
      getSessionMemoryState: () => this.config.getSessionMemoryState?.(),
      getMessages: () => this.session.getMessages(),
      getRecentToolHistory: () => this.recentToolHistory,
      getRepairHintTracker: () => this.repairHintTracker,
      getContextClaimStore: () => this.config.contextClaimStore,
      getPlaybookStore: () => this.config.playbookStore,
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      compactClient: this.config.compactClient,
      compactModel: this.config.compactModel,
      pressureMonitor: this.pressureMonitor,
      getTrajectoryEntries: () => this.trajectory.getEntries(),
      getStreamedText: () => this.streamedText,
      refreshLedger: () => { this.contextInjection.refreshLedger() },
    })
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
    const floor = this.config.reasoningFloor
    const rank: Record<string, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }
    const effective = (floor && (rank[effort] ?? 2) < (rank[floor] ?? 0)) ? floor : effort
    this.config.reasoningEffort = effective
    this.config.client.setReasoningEffort?.(effective)
  }

  getReasoningEffort(): import('./auto-reasoning.js').ReasoningEffort | undefined {
    return this.config.reasoningEffort
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
    this.lastCacheDiagnostic = this.compaction.refreshCacheDiagnostic(turn)
  }

  getLedger() { return this.session.getContextLedger() }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.contextInjection.addAnchor(kind, text)
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

  private async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
      emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
    }))
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
    this.contextInjection.reset()
    this.outputTokenEscalationCount = 0
    this.sensorium = null
    this.strategy = null
    this.thetaState = createThetaState(7)
    this.loadedPheromones = []
    this.intent.reset()
    this.perception.reset()
    this.sensoriumSnapshots = this.perception.getSnapshots()
    this.currentPhase = this.perception.getCurrentPhase()
    // Capture baseline canonical prefix fingerprint for drift detection
    this.baselineFingerprint = this.config.promptEngine.getFingerprint()
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.stigmergyStore.prune().catch(() => {})
    this.stigmergyStore.query().then(p => { this.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})
    this.contextInjection.recordUserInputClaims(userInput)
    this.contextInjection.refreshPlaybookLessons(userInput)
    this.session.addUserMessage(userInput)

    if (this.config.autoReasoning) {
      this.config.reasoningEffort = selectReasoningEffort(userInput, this.config.reasoningFloor)
      this.config.client.setReasoningEffort?.(this.config.reasoningEffort)
    }

    let checkpointCreatedThisTurn = false

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        if (this.abortController.signal.aborted) {
          callbacks.onAbort()
          return
        }

        const estTokens = this.session.getEstimatedTokens()
        const compactResult = await this.compaction.maybeCompact({
          loopTurn: turn,
          failures: this.compactFailures,
        })
        this.compactFailures = compactResult.failures

        this.streamedText = ''
        this.lastPrewarmAt = 0
        await this.prewarmRecentReads()

        // ── Git freshness: file change rate (Zeitgeber signal) ──
        getGitChangeRate(this.cwd).then(rate => {
          this.gitChangeRate = smoothChangeRate(rate, this.gitChangeRate)
        }).catch(() => {})

        // ── StarFlow v2: Sensorium computation ──
        const pressureResult = this.pressureMonitor.check(estTokens, this.session.getTurnCount())
        const perceptionResult = await this.perception.perceive({
          turn: this.session.getTurnCount(),
          estimatedTokens: estTokens,
          pressureResult,
          evidenceState: this.evidence.getState(),
          predictionAccumulator: this.predictionAccumulator,
          recentToolHistory: this.recentToolHistory,
          loadedPheromones: this.loadedPheromones,
          traceStore: this.traceStore,
          gitChangeRate: this.gitChangeRate,
          sensorium: this.sensorium,
          strategy: this.strategy,
          vigor: this.vigorState,
          thetaState: this.thetaState,
          thetaTelemetry: this.thetaTelemetry,
          thetaCheckInFlight: this.thetaCheckInFlight,
          baselineFingerprint: this.baselineFingerprint,
        }, {
          emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
        })
        this.sensorium = perceptionResult.sensorium
        this.strategy = perceptionResult.strategy
        this.vigorState = perceptionResult.vigor
        this.thetaState = perceptionResult.thetaState
        this.currentPhase = perceptionResult.event.phase
        this.sensoriumSnapshots = this.perception.getSnapshots()
        const currentSensorium: Sensorium = perceptionResult.sensorium
        const currentStrategy: StrategyProfile = perceptionResult.strategy

        const intentResult = await this.intent.evaluate({
          strategy: currentStrategy,
          vigor: this.vigorState,
          sensorium: currentSensorium,
          pheromones: this.loadedPheromones,
          pressureResult,
          recentToolHistory: this.recentToolHistory,
          onIntentPreview: callbacks.onIntentPreview,
        })
        if (intentResult === 'veto') {
          callbacks.onPhaseChange?.('intent-veto', { reason: 'user vetoed intent', suggestion: 're-plan before tool use' })
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
          continue
        }

        // Pass 5: adaptive repair hint injection
        this.contextInjection.refreshRepairHint()

        this.compaction.enforceContextCeiling()
        this.contextInjection.refreshActiveClaims()
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
          await this.runPostSession(callbacks)
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
          this.contextInjection.setCerebellarHint(level)

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
            this.contextInjection.clearCerebellarHint()
          }
          if (this.config.autoReasoning && this.config.reasoningEffort) {
            this.config.reasoningEffort = adjustReasoningEffort(this.config.reasoningEffort, level)
            this.config.client.setReasoningEffort?.(this.config.reasoningEffort)
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
          this.contextInjection.refreshLedger()
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
        this.contextInjection.refreshLedger()
        this.refreshCacheDiagnostic(turn)
        this.recordTurnSnapshot()
        await this.runtimeHooks.runPostTurn(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
          emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) },
        }))
        await this.runPostSession(callbacks)
        callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), true)
        this.evidence.reset()
        break
      }
    } catch (err) {
      this.evidence.reset()
      if ((err as Error).name === 'AbortError') {
        await this.runPostSession(callbacks)
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    }
  }
}
