import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { PromptEngine } from '../prompt/engine.js'
import type { PromptMode } from '../prompt/mode.js'
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
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import { evaluateThinkingRetry } from './thinking-retry.js'
import { createPredictionAccumulator } from './prediction-error.js'
import type { PredictionAccumulator } from './prediction-error.js'
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
import { buildActiveDomain, type ActiveStarDomain } from './star-domain.js'
import { ArtifactStore } from '../artifact/store.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { TurnStreamController } from './turn-stream.js'
import { classifySeason, type CognitiveSeason } from './cognitive-season.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { buildCognitivePromptProjection, createCognitiveLedger, getCognitivePhaseSnapshot, type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { compactStaleRoundsOai } from '../compact/stale-round.js'
import { microCompactOai } from '../compact/micro.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorOptions, type ResourceSensorSnapshot } from './resource-sensor.js'
import { advanceContractStatus, contractStatusFromPhaseClass, extractTaskContract, type TaskContract } from '../context/task-contract.js'
import { StigmergyStore } from '../context/stigmergy.js'
import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'
import { ProviderHealthTracker } from './provider-health.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { IntentPreview, IntentPreviewAction } from './intent-preview.js'
import type { PlaybookStore } from './playbook-store.js'
import type { SensoriumEntry } from './retrospect.js'
import { join } from 'node:path'
import { formatEventsForAppendix } from './hooks/cross-session-hook.js'

/** Map StarPhase values to PromptEngine phaseClass strings. */
const PHASE_CLASS_MAP: Record<string, string> = {
  'tianshu-planning': 'plan',
  'tianxuan-locating': 'explore',
  'tianji-decomposing': 'plan',
  'tianquan-contracting': 'plan',
  'yuheng-implementing': 'execute',
  'kaiyang-testing': 'verify',
  'yaoguang-delivering': 'deliver',
  'tianshu-encore': 'plan',
}

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
  providerProfile?: ProviderProfile
  compactClient?: StreamClient
  compactModel?: string
  approvalMode?: ApprovalMode
  sessionId?: string
  /** Optional session registry for cross-session event communication. */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
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
  /** Optional resource sensor injection for reliability tests and custom deployments. */
  resourceSensorOptions?: ResourceSensorOptions
  /** Disable fs watcher in tests or constrained environments. Enabled by default. */
  fsWatcherEnabled?: boolean
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
  private sessionDomain: ActiveStarDomain | null | undefined
  private static readonly MAX_OUTPUT_ESCALATION = 3
  private pressureMonitor: PressureMonitor
  private sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  private turnBudget: TurnBudget = createTurnBudget(0)
  private sensorium: Sensorium | null = null
  private strategy: StrategyProfile | null = null
  private vigorState: VigorState = createVigorState()
  private runtimeHooks: RuntimeHookPipeline
  private perception: TurnPerceptionController
  private intent: TurnIntentController
  private contextInjection: ContextInjectionController
  private compaction: CompactionController
  private turnStream: TurnStreamController | null = null
  private turnCompletion: TurnCompletionController
  private toolExecution: ToolExecutionController
  private thetaCheckInFlight = false
  private thetaTelemetry: { lastReason: string | null; lastDurationMs: number | null; lastErrorCount: number; lastTimedOut: boolean; requestedCount: number } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
  }
  private thetaState: ThetaState = createThetaState(7)
  private artifactStore: import('../artifact/store.js').ArtifactStore | undefined
  private sessionStateManager: SessionStateManager | undefined
  private stigmergyStore: StigmergyStore
  private loadedPheromones: Pheromone[] = []
  private lastSeenEventId = 0
  private gitChangeRate = 0
  private telemetryWriter: TelemetryWriter
  private baselineFingerprint: PrefixFingerprint | null = null
  private sensoriumSnapshots: SensoriumEntry[] = []
  private taskContract?: TaskContract
  private latestCognitiveSnapshot?: CognitivePhaseSnapshot
  private persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  private latestResourceSnapshot: ResourceSensorSnapshot | null = null
  private latestReliabilityDecision: ReliabilityDecision | null = null
  private fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  private latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  private currentSeason: CognitiveSeason | null = null
  private lastCompactTurn: number | null = null

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
    this.resourceSensor = new ResourceSensor(this.config.resourceSensorOptions)
    this.fsWatcher = this.config.fsWatcherEnabled === false ? null : createFsWatcher({ cwd: this.cwd })
    this.telemetryWriter = createTelemetryWriter(this.cwd)
    const pheromonesPath = join(this.cwd, '.rivet', 'pheromones.json')
    this.stigmergyStore = new StigmergyStore(pheromonesPath)

    // Initialize ArtifactStore for append-only artifact log
    if (this.config.sessionId) {
      const artifactDir = join(this.cwd, '.rivet', 'artifacts')
      this.artifactStore = new ArtifactStore(artifactDir, this.config.sessionId)
      const stateManager = new SessionStateManager(this.config.sessionId)
      this.sessionStateManager = stateManager
    }

    this.runtimeHooks = this.config.runtimeHooks ?? new RuntimeHookPipeline(createDefaultRuntimeHooks({
      stigmergyDeposit: deposit => this.stigmergyStore.deposit(deposit),
      stigmergyQuery: () => this.stigmergyStore.query(),
      getEvidenceState: () => this.evidence.getState(),
      setLoadedPheromones: pheromones => { this.loadedPheromones = mapQueriedPheromones(pheromones) },
      publishEvent: this.config.sessionRegistry && this.config.sessionId
        ? (input) => this.config.sessionRegistry!.publishEvent(this.config.sessionId!, input)
        : undefined,
      sessionId: this.config.sessionId,
      getThetaState: () => this.thetaState,
      setThetaState: state => { this.thetaState = state },
      getPredictionAccumulator: () => this.predictionAccumulator,
      playbookStore: this.config.playbookStore,
      buildRetrospectInput: () => {
        const es = this.evidence.getState()
        return {
          sensoriumEntries: this.sensoriumSnapshots, gitLog: [],
          toolEvents: this.traceStore.events.filter(e => e.kind === 'tool').map(e => ({ turn: e.turn, name: e.name, status: e.status === 'passed' ? 'passed' : 'failed' })),
          evidenceSummary: { filesModified: es.filesModified.size, verifiedCount: es.verifications.filter(v => v.status === 'passed').length },
          pheromoneSignals: this.loadedPheromones.map(p => ({ signal: p.signal, path: p.path, strength: p.strength })),
        }
      },
      getDoomLoopLevel: () => this.getDoomLoopLevel(),
      telemetryWriter: this.telemetryWriter,
      getDomainId: () => this.sessionDomain?.id ?? null,
      getFileObservations: () => this.config.contextClaimStore?.listClaims({ kind: ['file_observation'] }) ?? [],
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
      getMessages: () => this.session.getOaiMessages(),
      getRecentToolHistory: () => this.recentToolHistory,
      getRepairHintTracker: () => this.repairHintTracker,
      getContextClaimStore: () => this.config.contextClaimStore,
      getPlaybookStore: () => this.config.playbookStore,
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      providerProfile: this.config.providerProfile,
      compactClient: this.config.compactClient,
      compactModel: this.config.compactModel,
      pressureMonitor: this.pressureMonitor,
      getTrajectoryEntries: () => this.trajectory.getEntries(),
      getStreamedText: () => this.streamedText,
      refreshLedger: () => { this.contextInjection.refreshLedger() },
    })
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController()
    this.toolExecution = this.createToolExecutionController()
    
    // 初始化 SessionPersist 用于 fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId)
    }
  }

  private createTurnStreamController(): TurnStreamController {
    return new TurnStreamController({
      client: this.config.client,
      abortSignal: this.abortController?.signal ?? new AbortController().signal,
      getStreamedTextLength: () => this.streamedText.length,
      appendStreamedText: text => { this.streamedText += text },
      getLastPrewarmAt: () => this.lastPrewarmAt,
      setLastPrewarmAt: position => { this.lastPrewarmAt = position },
      maybePrewarm: text => { this.maybePrewarm(text) },
      addUsage: usage => { this.session.addUsage(usage) },
      recordTurnCache: (turn, usage) => { this.session.recordTurnCache(turn, usage) },
    })
  }

  private createTurnCompletionController(callbacks?: AgentCallbacks): TurnCompletionController {
    return new TurnCompletionController({
      config: this.config,
      session: this.session,
      trajectory: this.trajectory,
      routingMetrics: this.routingMetrics,
      evidence: this.evidence,
      getStreamedText: () => this.streamedText,
      getDecisions: () => this.decisions,
      setDecisions: decisions => { this.decisions = decisions },
      refreshLedger: () => { this.contextInjection.refreshLedger() },
      refreshCacheDiagnostic: turn => { this.refreshCacheDiagnostic(turn) },
      recordTurnSnapshot: () => { this.recordTurnSnapshot() },
      runPostTurn: async () => {
        await this.runtimeHooks.runPostTurn(createRuntimeHookContext(this.buildRuntimeSnapshot(), {
          emitPhaseChange: (phase, detail) => { callbacks?.onPhaseChange?.(phase, detail) },
        }))
      },
      runBeforeComplete: async () => {
        if (callbacks) await this.runPostSession(callbacks)
      },
    })
  }

  private createToolExecutionController(): ToolExecutionController {
    return new ToolExecutionController({
      config: this.config,
      cwd: this.cwd,
      harness: this.harness,
      prewarm: this.prewarm,
      evidence: this.evidence,
      repairHintTracker: this.repairHintTracker,
      repairPipeline: this.repairPipeline,
      runtimeHooks: this.runtimeHooks,
      contextInjection: this.contextInjection,
      trajectory: this.trajectory,
      getPredictionAccumulator: () => this.predictionAccumulator,
      setPredictionAccumulator: a => { this.predictionAccumulator = a },
      getVigorState: () => this.vigorState,
      setVigorState: v => { this.vigorState = v },
      getDoomLoopLevel: () => this.getDoomLoopLevel(),
      getSessionTurnCount: () => this.session.getTurnCount(),
      getSessionId: () => this.config.sessionId,
      addToolResults: results => { this.session.addToolResults(results) },
      recordToolHistory: (name, input, isError, content) => this.recordToolHistory(name, input, isError, content),
      buildRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      getAutoReasoning: () => this.config.autoReasoning ?? false,
      getReasoningEffort: () => this.config.reasoningEffort,
      setClientReasoningEffort: effort => { this.config.reasoningEffort = effort; this.config.client.setReasoningEffort?.(effort) },
      getSensorium: () => this.sensorium,
      getReliabilityDecision: () => this.latestReliabilityDecision,
      getTurnBudget: () => this.turnBudget,
      artifactStore: this.artifactStore,
      sessionStateManager: this.sessionStateManager,
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
      season: this.currentSeason,
      ...extra,
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

  private bindSessionDomain(taskDescription: string): void {
    if (this.sessionDomain !== undefined) return
    this.sessionDomain = isStarSoulEnabled() ? buildActiveDomain(taskDescription) : null
    this.config.promptEngine.setActiveDomain(this.sessionDomain)
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

  getVerificationSummary() { return this.evidence.getVerificationSummary() }

  setPromptMode(mode: PromptMode): void {
    this.config.promptEngine.setMode(mode)
  }

  getPromptMode(): PromptMode {
    return this.config.promptEngine.getMode()
  }

  getLatestPheromones() { return this.loadedPheromones }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' { return getDoomLoopLevel(this.traceStore.toolFingerprints) }

  getReliabilityDecision(): ReliabilityDecision | null { return this.latestReliabilityDecision }

  private sessionPersistPath(): string | undefined {
    return this.persist?.getFilePath()
  }

  private refreshReliabilityDecision(): void {
    this.latestResourceSnapshot = this.resourceSensor.sample(this.sessionPersistPath())
    const disk = this.latestResourceSnapshot.disk
    const trigger = classifyRecoveryTrigger({
      interrupt: {
        interruptCountThisTurn: 0,
        hasPendingTools: false,
        turn: this.session.getTurnCount(),
      },
      doomLoop: {
        doomLoopLevel: this.getDoomLoopLevel(),
        recentFingerprints: this.traceStore.toolFingerprints.slice(-20),
        uniqueFingerprintCount: new Set(this.traceStore.toolFingerprints.slice(-20)).size,
      },
      thrashing: {
        compactionTurns: this.pressureMonitor.getCompactionTurns(),
        currentTurn: this.session.getTurnCount(),
        consecutiveCompactFailures: this.compactFailures.consecutiveFailures,
        estimatedTokens: this.session.getEstimatedTokens(),
        contextWindow: this.config.contextWindow,
        lastCompactFailed: this.compactFailures.consecutiveFailures > 0,
      },
      integrity: {
        orphanToolUseCount: 0,
        orphanToolResultCount: 0,
        wasRepaired: false,
        syntheticResultsInserted: 0,
        messageCount: this.session.getOaiMessages().length,
      },
      resourcePressure: {
        rssBytes: this.latestResourceSnapshot.memory.rssBytes,
        heapUsedBytes: this.latestResourceSnapshot.memory.heapUsedBytes,
        memoryLimitBytes: this.latestResourceSnapshot.memory.memoryLimitBytes,
        sessionBytes: disk?.sessionBytes ?? 0,
        sessionByteLimit: disk?.sessionByteLimit ?? Number.POSITIVE_INFINITY,
        memoryTrendBytesPerSample: this.latestResourceSnapshot.memoryTrendBytesPerSample,
      },
    })
    this.latestReliabilityDecision = modeForRecoveryTrigger(trigger)
  }

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

  getCognitiveSnapshot(): CognitivePhaseSnapshot | undefined { return this.latestCognitiveSnapshot }

  addAnchor(kind: ContextAnchor['kind'], text: string): void {
    this.contextInjection.addAnchor(kind, text)
  }

  getFileHistory() { return this.config.fileHistory }

  getDebugInfo() {
    const fp = this.config.promptEngine.getFingerprint()
    const sysPrompt = this.config.promptEngine.getSystemPrompt()
    return { fingerprint: fp, drift: this.config.promptEngine.checkDrift(),
      systemPromptLength: sysPrompt.length,
      systemPromptPreview: sysPrompt.slice(0, 200) + (sysPrompt.length > 200 ? '...' : ''),
      toolCount: this.config.toolRegistry.getDefinitions().length,
      toolNames: this.config.toolRegistry.getDefinitions().map(t => t.name),
      volatilePayloadReport: this.config.promptEngine.getVolatilePayloadReport(this.recentToolHistory) }
  }

  private recordTurnSnapshot(): void {
    if (!this.config.sessionId) return
    new SessionPersist(this.config.sessionId).appendTurnSnapshot({
      turn: this.session.getTurnCount(), timestamp: Date.now(),
      messageCount: this.session.getOaiMessages().length,
      estimatedTokens: this.session.getEstimatedTokens(),
    })
  }

  private async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(),
      { emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) } }))
    // Cleanup old cross-session events (2h TTL)
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }
  }

  private async startFsWatcher(): Promise<void> {
    try {
      await this.fsWatcher?.start()
    } catch {
      // fs.watch is an opportunistic external signal; unavailable watchers must not block turns.
    }
  }

  private stopFsWatcher(): void {
    this.fsWatcher?.stop()
    this.latestFsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  }

  async run(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    this.abortController = new AbortController()
    await this.startFsWatcher()
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController(callbacks)
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
    this.latestResourceSnapshot = null
    this.latestReliabilityDecision = null
    this.thetaState = createThetaState(7)
    this.loadedPheromones = []
    this.intent.reset()
    this.perception.reset()
    this.sensoriumSnapshots = this.perception.getSnapshots()
    this.latestCognitiveSnapshot = undefined
    // Capture baseline canonical prefix fingerprint for drift detection
    this.baselineFingerprint = this.config.promptEngine.getFingerprint()
    // Load cross-session pheromones for Sensorium.freshness computation.
    // Use query() so Sensorium sees decayed currentStrength, and prune stale entries opportunistically.
    this.stigmergyStore.prune().catch(() => {})
    this.stigmergyStore.query().then(p => { this.loadedPheromones = mapQueriedPheromones(p) }).catch(() => {})

    this.bindSessionDomain(userInput)
    this.contextInjection.recordUserInputClaims(userInput)
    this.contextInjection.refreshPlaybookLessons(userInput)
    this.session.addUserMessage(userInput)
    const isChatMode = this.config.promptEngine.getMode() === 'chat'
    this.taskContract = isChatMode ? undefined : extractTaskContract(userInput, this.session.getTurnCount())

    if (this.config.autoReasoning && !isChatMode) {
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
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- TS narrows to null but later turns reassign
        const snap = this.latestResourceSnapshot as ResourceSensorSnapshot | null
        const rssRatio = snap
          ? snap.memory.rssBytes / snap.memory.memoryLimitBytes
          : 0
        this.turnBudget = createTurnBudget(rssRatio)
        
        // Fuzzy checkpoint: 记录 compact 开始
        if (this.persist) {
          this.persist.appendCompactStart(turn, this.session.getOaiMessages().length)
        }
        
        const compactResult = await this.compaction.maybeCompact({
          loopTurn: turn,
          failures: this.compactFailures,
        })
        this.compactFailures = compactResult.failures
        if (compactResult.compacted) {
          this.lastCompactTurn = turn
          // Hint V8 to release freed message objects sooner
          if (typeof globalThis.gc === 'function') globalThis.gc()
        }

        // Stale round compaction: proactively shrink N-2+ tool_results
        if (!compactResult.compacted) {
          const before = this.session.getOaiMessages()
          const after = compactStaleRoundsOai(before, this.config.contextWindow ?? 1_000_000)
          if (after !== before) {
            this.session.replaceOaiMessages(after)
            if (typeof globalThis.gc === 'function') globalThis.gc()
          }
        }

        // Heap-driven forced compaction: when memory pressure is high but token
        // threshold hasn't been reached (100万 window is too large to fill),
        // force compaction by pretending contextWindow is smaller.
        const heapRatio = snap
          ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
          : 0
        if (!compactResult.compacted && heapRatio >= 0.6 && this.session.getOaiMessages().length >= 10) {
          const before = this.session.getOaiMessages()
          // Use microCompact with a virtual smaller window to force message dropping
          const virtualWindow = Math.floor((this.config.contextWindow ?? 1_000_000) * 0.3)
          const { messages: trimmed } = microCompactOai(before, virtualWindow, this.session.getEstimatedTokens())
          if (trimmed.length < before.length || trimmed !== before) {
            this.session.replaceOaiMessages(trimmed)
            if (typeof globalThis.gc === 'function') globalThis.gc()
          }
        }

        // Fuzzy checkpoint: 记录 compact 结束
        if (this.persist) {
          this.persist.appendCompactEnd(turn, this.session.getOaiMessages().length)
        }

        this.streamedText = ''
        this.lastPrewarmAt = 0
        await this.prewarmRecentReads()

        // ── Git freshness: file change rate (Zeitgeber signal) ──
        getGitChangeRate(this.cwd).then(rate => {
          this.gitChangeRate = smoothChangeRate(rate, this.gitChangeRate)
        }).catch(() => {})

        // ── FS freshness: realtime external Zeitgeber signal ──
        this.latestFsWatcherState = this.fsWatcher?.getState() ?? { eventRate: 0, eventCount: 0, active: false }

        // ── StarFlow v2: Sensorium computation ──
        const pressureResult = this.pressureMonitor.check(estTokens, this.session.getTurnCount())
        if (isChatMode) {
          this.config.promptEngine.setCognitiveProjection(null)
          this.config.promptEngine.setTaskProgress({ completed: [], current: 'chat-mode', remaining: [] })
        }
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
          fsEventRate: this.latestFsWatcherState.eventRate,
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
        this.sensoriumSnapshots = this.perception.getSnapshots()
        const currentSensorium: Sensorium = perceptionResult.sensorium
        const currentStrategy: StrategyProfile = perceptionResult.strategy

        // ── 认知季节 — 道德经四章螺旋 ──
        const seasonResult = classifySeason({
          turn,
          doomLevel: this.getDoomLoopLevel(),
          recentCompactTurn: this.lastCompactTurn,
          sensoriumStability: currentSensorium.stability,
        })
        this.currentSeason = seasonResult.season

        // Wire StarPhase → phaseClass for field habituation modulation
        const phaseClass = PHASE_CLASS_MAP[perceptionResult.event.phase] ?? 'plan'
        this.config.promptEngine.setPhaseHint(phaseClass)
        const contractStatus = contractStatusFromPhaseClass(phaseClass)
        if (this.taskContract && contractStatus) {
          this.taskContract = advanceContractStatus(this.taskContract, contractStatus, this.session.getTurnCount())
        }

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

        this.refreshReliabilityDecision()

        this.compaction.enforceContextCeiling()
        this.contextInjection.refreshActiveClaims()

        // ── Sycophancy Trap: record previous turn agreement ──
        // 仁者必有勇。连续同意 + confidence 下降 → 质疑注入。
        // agreedWithUser: 最近是否使用了 ask_user_question（质疑）？
        // 没质疑就执行 → 过度服从 = agreed；先质疑再执行 → 独立判断。
        const recentToolNames = this.recentToolHistory.slice(-8).map(h => h.tool)
        const hadAskTool = recentToolNames.includes('ask_user_question')
        const hadDestructive = recentToolNames.some(
          t => t === 'write_file' || t === 'edit_file' || t === 'bash'
        )
        const agreedWithUser = hadDestructive && !hadAskTool
        if (!isChatMode && (hadDestructive || hadAskTool)) {
          this.sycophancyTrap.recordTurn({
            agreedWithUser,
            confidence: this.sensorium?.confidence ?? 0.5,
          })
        }

        const cognitiveLedger = createCognitiveLedger({
          contract: this.taskContract,
          evidence: this.evidence.getState(),
          trace: this.traceStore,
          turn: this.session.getTurnCount(),
          // 道常无为而无不为：CVM throttle — skip mirror when overhead > 5%
          sensorium: pressureResult.shouldThrottleCvm ? null : this.sensorium,
          strategy: pressureResult.shouldThrottleCvm ? null : this.strategy,
          vigor: pressureResult.shouldThrottleCvm ? null : this.vigorState,
          season: pressureResult.shouldThrottleCvm ? null : this.currentSeason,
          // CVM uncertainty trap: risk level from latest tool assessment
          riskLevel: this.latestRisk.level,
        })
        this.latestCognitiveSnapshot = getCognitivePhaseSnapshot(cognitiveLedger)
        const sycophancyHint = isChatMode ? undefined : this.sycophancyTrap.getHint()
        const projection = isChatMode ? '' : buildCognitivePromptProjection(cognitiveLedger, { sycophancyHint })
        this.config.promptEngine.setCognitiveProjection(projection)

        // ── CVM overhead tracking ──
        // 盘古呼吸：CVM 保护的资源（context）也是它消耗的资源。
        // 追踪每次注入的 token 估计，防止认知氧气被自身消耗殆尽。
        // chars / 4 ≈ tokens (crude but fast estimate for overhead ratio)
        if (!isChatMode) {
          const cvmTokenEstimate = Math.ceil(projection.length / 4)
          this.pressureMonitor.recordCvmInjection(cvmTokenEstimate) // Called after setting projection
        }
        // ── Cross-session event sync ──
        // Read events from other sessions (cache-safe: injected into dynamic appendix only)
        if (this.config.sessionRegistry && this.config.sessionId) {
          const events = this.config.sessionRegistry.consumeEvents(this.config.sessionId, this.lastSeenEventId)
          if (events.length > 0) {
            this.lastSeenEventId = Math.max(...events.map(e => e.id))
            this.config.promptEngine.setCrossSessionEvents(formatEventsForAppendix(events))
          } else {
            this.config.promptEngine.setCrossSessionEvents(null)
          }
        }
        // Inject session state snapshot into volatile block before building request
        if (this.sessionStateManager) {
          this.config.promptEngine.setSessionState(this.sessionStateManager.renderForVolatile())
        }
        const request = this.config.promptEngine.buildOaiRequest(this.session.getOaiMessages(), this.recentToolHistory)
        const streamResult = await this.turnStream!.streamTurn({
          request,
          turn,
          lastTurnTextFingerprint: this.lastTurnTextFingerprint,
          callbacks: {
            onTextDelta: callbacks.onTextDelta,
            onThinkingDelta: callbacks.onThinkingDelta,
            onToolUse: callbacks.onToolUse,
            onError: callbacks.onError,
          },
        })
        const { collectedBlocks, thinkingAccum, toolUses, stopReason, streamError } = streamResult
        this.lastTurnTextFingerprint = streamResult.lastTurnTextFingerprint

        if (this.abortController.signal.aborted) {
          if (this.streamedText.length > 0) this.session.addUsage({ output_tokens: Math.ceil(this.streamedText.length / 4) })
          await this.runPostSession(callbacks)
          callbacks.onAbort()
          return
        }

        if (streamError) {
          if (collectedBlocks.length > 0) { this.session.addAssistantBlocks(collectedBlocks); this.recordTurnSnapshot() }
          callbacks.onError(streamError)
          return
        }

        if (collectedBlocks.length > 0) this.session.addAssistantBlocks(collectedBlocks)

        if (stopReason === 'max_output_tokens' && toolUses.length === 0 && this.outputTokenEscalationCount < AgentLoop.MAX_OUTPUT_ESCALATION) {
          this.outputTokenEscalationCount++
          this.session.addUserMessage('Continue your response from where you left off.')
          continue
        }

        if (toolUses.length > 0) {
          const r = await this.toolExecution.executeBatch({
            toolUses, callbacks, turn, checkpointCreatedThisTurn,
            abortSignal: this.abortController.signal,
            traceStore: this.traceStore, importGraph: this.importGraph,
            lastConflictCheckCount: this.lastConflictCheckCount, latestRisk: this.latestRisk,
          })
          ;({ traceStore: this.traceStore, importGraph: this.importGraph,
             lastConflictCheckCount: this.lastConflictCheckCount, latestRisk: this.latestRisk } = r)
          if (r.checkpointCreated) checkpointCreatedThisTurn = true
          await this.turnCompletion.complete({ turn, isFinal: false, callbacks })
          continue
        }

        // Thinking-only turn detection: retry if model produced reasoning but no text/tools
        const thinkingResult = evaluateThinkingRetry({
          streamedText: this.streamedText, collectedBlockCount: collectedBlocks.length,
          thinkingAccum, thinkingOnlyRetries: this.thinkingOnlyRetries,
          lastThinkingContent: this.lastThinkingContent,
        })
        this.lastThinkingContent = thinkingResult.nextState.lastThinkingContent
        this.thinkingOnlyRetries = thinkingResult.nextState.thinkingOnlyRetries
        if (thinkingResult.shouldRetry) {
          this.session.addUserMessage(thinkingResult.retryMessage)
          continue
        }

        await this.turnCompletion.complete({
          turn,
          isFinal: true,
          emitBadge: true,
          callbacks,
        })
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
    } finally {
      this.stopFsWatcher()
    }
  }
}
