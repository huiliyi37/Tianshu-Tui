import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { getGitInjectedContext } from '../prompt/volatile-git.js'
import { wrapSystemReminder } from '../prompt/system-reminder.js'
import { ToolRegistry } from '../tools/registry.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { attachSessionPersistListener } from './session-persist-listener.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm, buildPrewarmValueAsync } from './prewarm-file.js'
import { validatePathSafe } from '../tools/path-validate.js'
import { type CompactionConfig } from '../compact/constants.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import { EvidenceTracker } from './evidence.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import type { HookRegistry } from '../hooks/registry.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel, getClassDoomLoopLevel, combineDoomLoopLevels } from './trace-store.js'
import { evaluateConvergence } from './convergence-detector.js'
import type { PhaseClass, ConvergenceResult } from './convergence-detector.js'
import type { PlanExecutionTrace, StepResult } from './plan-execution-trace.js'
import { buildGateConvergenceHint } from './delivery-gate-v2.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { ModelCapabilityCard } from '../model/capability.js'
import type { ImportGraph } from './import-graph.js'
import type { PlanModeState } from './plan-mode.js'
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { ctclSanitizerPass } from './ctcl-sanitizer.js'
import { RepairHintTracker } from './repair-hint.js'
import type { PermissionConfig } from './permissions.js'
import { detectWorktreeReality, type InjectedWorktreeContext } from './worktree-reality.js'
import { type ApprovalResult } from './approval-edit.js'
import { selectReasoningEffort } from './auto-reasoning.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import { evaluateThinkingRetry } from './thinking-retry.js'
import { createPredictionAccumulator } from './prediction-error.js'
import type { PredictionAccumulator, EFEComponents } from './prediction-error.js'
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
import { mintNumericId, buildAgentMark, VOID_SYMBOL } from './void-identity.js'
import { buildDepartureMilestone } from '../constellation/milestone.js'
import { appendMilestone } from '../constellation/store.js'
import { ArtifactStore } from '../artifact/store.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { debugLog } from '../utils/debug.js'
import { TurnStreamController, type StreamRule } from './turn-stream.js'
import { classifySeason, type CognitiveSeason } from './cognitive-season.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { renderAffordanceHint, type AffordanceState, adaptAffordanceFromHistory } from './affordance.js'
import { getThetaPhase } from './star-event.js'
import { selectPolicy, renderPolicyGuidance } from './policy-selection.js'
import { computeEFE } from './prediction-error.js'
import { computeAffordanceScores } from './affordance.js'
import { renderPlanCacheAdvisory } from './plan-cache-advisory.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { buildCognitivePromptProjection, createCognitiveLedger, getCognitivePhaseSnapshot, type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { CacheAdvisor } from '../cache/advisor.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { TurnHeartbeat } from './turn-heartbeat.js'
import { rejectOnAbort } from './turn-boundary-abort.js'
import { abortableDelay } from '../api/retry-engine.js'
import { classifyApiError } from '../api/error-classifier.js'
import { createP3Integration, P3Integration } from './p3-integration.js'
import type { HealthSignal } from './trajectory-health.js'
import { ImmuneHook } from './immune-hook.js'
import { formatImmuneContext } from './immune-context.js'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, STALENESS_GATE_TURN_THRESHOLD, STALENESS_GATE_QUIET_WINDOW, disciplineReanchorEntry, stalenessGateEntry, vigorLowEntry } from './advisory-bus.js'
import { checkTddGate } from './tdd-gate.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
import { getPhysarumShadowStatsFromDb } from '../repo/physarum-shadow-stats.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorOptions, type ResourceSensorSnapshot } from './resource-sensor.js'
import { advanceContractStatus, classifyPlanMethodology, classifyTaskDepth, classifyTurnMode, contractStatusFromPhaseClass, extractTaskContract, type PlanMethodology, type TaskContract, type TaskDepthLayer, type TurnMode } from '../context/task-contract.js'
import { skillRegistry } from '../skills/skill-loader.js'
import { renderMemoryBlock } from '../memory/unified-memory.js'
import { parseMentions, renderMentionContext } from '../tui/mention-parser.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { createStanceTally } from './stance-tally.js'
import type { Pheromone } from '../context/stigmergy.js'
import { mapQueriedPheromones } from './pheromone-map.js'
import { ProviderHealthTracker } from './provider-health.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { IntentPreview, IntentPreviewAction } from './intent-preview.js'
import type { PlaybookStore } from './playbook-store.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import { normalizeAntiAnchoringConfig } from './anti-anchoring-config.js'
import type { SensoriumEntry } from './retrospect.js'
import { join } from 'node:path'
import { formatEventsForAppendix } from './hooks/cross-session-hook.js'
import type { ApprovalMode, AgentConfig, AgentCallbacks } from './loop-types.js'
import { recordToolHistory } from "./tool-history-recorder.js";
import { requestThetaCheck } from "./theta-controller.js";
import { createTurnStreamController, createTurnCompletionController, createToolExecutionController, createPlanTraceCoordinator, createCompactBoundaryCoordinator, createTurnOrchestrator, createReasoningEffortController, createIntentRetrievalRouteController, createAntiAnchoringController, createModelRoutingShadowController, createPrewarmController, buildRuntimeSnapshot } from "./loop-factory.js";
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { loadSessionMemories } from './session-memory-warmup.js'
import type { PlanTraceCoordinator } from "./plan-trace-coordinator.js";
import type { CompactBoundaryCoordinator } from "./compact-boundary-coordinator.js";
import type { TurnOrchestrator } from "./turn-orchestrator.js";
import { wrapCallbacksWithHeartbeat } from "./turn-orchestrator.js";
import { type EffortShadowRecord } from './p3-reward.js'

export type { ApprovalMode, AgentConfig, AgentCallbacks }

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


export class AgentLoop {
    session!: SessionContext;
    config!: AgentConfig;
  abortController: AbortController | null = null
  /** Count of user interrupts within the current turn (中#5). */
  private _turnInterruptCount = 0
  /**
   * Pending-abort latch: set by abort() so an interrupt fired during the
   * init/warmup window (before the turn loop) is honored rather than lost.
   * Reset at the start of each run().
   */
  private _pendingAbort = false
  cwd: string
  evidence: EvidenceTracker
  compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  recentToolHistory: ToolHistoryEntry[] = []
  prewarm = new PrewarmCache(60_000, 50)
  private _running = false
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
  streamedText = ''
  thinkingOnlyRetries = 0
  lastThinkingContent = ''
  consecutiveNoToolTurns = 0
  lastTurnTextFingerprint = ''
  lastTurnThinkingFingerprint = ''
  lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  /** Latest per-turn free-energy signals — consumed by coordinator EFE worker routing. */
  private latestPolicySignals?: { efe: EFEComponents; sensorium: Sensorium }
  planModeState: PlanModeState = 'off'
  decisions: string[] = []
  trajectory = new TrajectoryRecorder()
  repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  repairHintTracker = new RepairHintTracker()
  traceStore: TraceStore
  harness: TurnHarness
  routingMetrics = new RoutingMetricsCollector()
  importGraph: ImportGraph | null = null
  lastConflictCheckCount = 0
  predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  private sessionDomain: ActiveStarDomain | null | undefined
  /** Agent's self-chosen departure mark (leave_mark tool); sealed by the
   *  constellation post-session hook. Null until the agent leaves a mark. */
  private pendingLeaveMark: import('../tools/types.js').LeaveMarkInput | null = null
  /** Ephemeral per-session numeric id, minted on first run. Used in welcome
   *  display and passed to buildAgentMark when the agent departs. */
  private _sessionNumericId: number | null = null

  /** The session's ephemeral numeric identity (e.g. 7281). Minted lazily. */
  get sessionNumericId(): number {
    if (this._sessionNumericId === null) {
      this._sessionNumericId = mintNumericId()
    }
    return this._sessionNumericId
  }
  /** U6: most recent convergence-detector result — consumed by the replan loop's
   *  detectDeviation (blocked/stalled signals). Null until first convergence check. */
  latestConvergenceResult: ConvergenceResult | null = null
  /** U6: autonomous plan execution trace. Created per task (initializeRun), steps
   *  seeded from the first todo write (capturePlanSteps), advanced per tool-turn,
   *  and checked for deviation at each turn boundary. Null outside task context. */
  planTrace: PlanExecutionTrace | null = null
  /** U6: last replan correction injected as a system-reminder — dedup guard so a
   *  persistent deviation doesn't spam an identical nudge every turn. */
  lastReplanInjection = ''
  /** Session-local affordance adaptations — per-session, never mutates global registry */
  private sessionAffordanceAdaptations: Record<string, import('./affordance.js').BaseAffordance> = {}
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  private prevAnchorGraphHash: string | null = null
  /** Previous turn's streamed assistant text for dedup-guard P5. */
  private prevStreamedText: string | null = null
  private pressureMonitor: PressureMonitor
  private sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  private sycophancyWasActive = false
  turnBudget: TurnBudget = createTurnBudget(0)
  sensorium: Sensorium | null = null
  strategy: StrategyProfile | null = null
  vigorState: VigorState = createVigorState()
  runtimeHooks: RuntimeHookPipeline
  private perception: TurnPerceptionController
  private intent: TurnIntentController
  contextInjection: ContextInjectionController
  compaction: CompactionController
  turnStream: TurnStreamController | null = null
  turnCompletion: TurnCompletionController
  toolExecution: ToolExecutionController
  planTraceCoordinator: PlanTraceCoordinator
  private compactBoundaryCoordinator: CompactBoundaryCoordinator
  private turnOrchestrator: TurnOrchestrator
  private reasoningEffort: ReasoningEffortController
  private intentRoute: IntentRetrievalRouteController
  private antiAnchoring: AntiAnchoringController
  private modelRoutingShadow: ModelRoutingShadowController
  prewarmController: PrewarmController
  thetaCheckInFlight = false
  thetaTelemetry: {
    lastReason: string | null
    lastDurationMs: number | null
    lastErrorCount: number
    lastTimedOut: boolean
    requestedCount: number
    /** Number of consecutive theta checks that timed out. Reset to 0 on success. */
    consecutiveTimeouts: number
    /** Turn number at which backoff expires. 0 = no backoff active. */
    cooldownUntilTurn: number
  } = {
    lastReason: null,
    lastDurationMs: null,
    lastErrorCount: 0,
    lastTimedOut: false,
    requestedCount: 0,
    consecutiveTimeouts: 0,
    cooldownUntilTurn: 0,
  }
  /** Max theta checks per session. Prevents runaway tsc spawning. */
  thetaRequestsThisTurn = 0
  private thetaState: ThetaState = createThetaState(7)
  artifactStore: import('../artifact/store.js').ArtifactStore | undefined
  sessionStateManager: SessionStateManager | undefined
  private stigmergyStore: StigmergyStore
  private loadedPheromones: Pheromone[] = []
  private readonly stanceTally = createStanceTally()
  private lastSeenEventId = 0
  gitChangeRate = 0
  telemetryWriter: TelemetryWriter
  private baselineFingerprint: PrefixFingerprint | null = null
  private sensoriumSnapshots: SensoriumEntry[] = []
  taskContract?: TaskContract
  private latestCognitiveSnapshot?: CognitivePhaseSnapshot
  private persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  latestResourceSnapshot: ResourceSensorSnapshot | null = null
  latestReliabilityDecision: ReliabilityDecision | null = null
  fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  currentSeason: CognitiveSeason | null = null
  lastCompactTurn: number | null = null
  _lastRetrievalRoute: import('./intent-retrieval-route.js').RetrievalRoute | null = null
  private _taskDepthLayer: TaskDepthLayer | undefined = undefined
  private _planMethodology: PlanMethodology | undefined = undefined
  _prevPhaseHint: string | undefined = undefined
  /**
   * P2-5: mid-round history rewrites break the prefix cache between two API
   * calls inside one user round (cache-log #30: input +319, cacheRead
   * 50,304→17,792). Pressure detected mid-round is deferred via these flags
   * and processed at the next user-message boundary (turn 0), keeping the
   * session append-only within a round.
   */
  pendingStaleCompact = false
  pendingHeapCompact = false
  cacheAdvisor: CacheAdvisor
  p3: P3Integration
  immuneHook: ImmuneHook
  _lastImmuneHint?: import('./immune-context.js').ImmuneContextHint
  /** A1: unified advisory bus — collects corrective signals, renders ≤3 per turn */
  advisoryBus = new AdvisoryBus()
  /** F-fix: tool calls since the last discipline re-anchor advisory. */
  private toolCallsSinceReanchor = 0
  /** Anti-habituation: turn count since last model-initiated objection/risk flag. */
  turnsSinceLastObjection = 0
  lastToolCompleteTime = 0
  initialUserMessage: string | null = null
  /** Sliding window of recent turn text fingerprints for cross-turn repetition detection. */
  recentTextFingerprints: string[] = []
  /** T2-02: Current effort shadow record (telemetry only in P0, influences effort in P3+) */
  _currentEffortShadow: EffortShadowRecord | null = null

  constructor(
    config: AgentConfig,
    session: SessionContext,
    cwd?: string,
  ) {
      this.config = config; this.session = session;
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
    this.telemetryWriter = createTelemetryWriter(this.cwd, this.config.sessionId)
    const sessionDir = join(this.cwd, '.rivet', 'sessions', this.config.sessionId ?? 'anon')
    const pheromonesPath = join(sessionDir, 'pheromones.json')
    this.stigmergyStore = new StigmergyStore(pheromonesPath)

    // Initialize ArtifactStore for append-only artifact log
    if (this.config.sessionId) {
      const artifactDir = join(this.cwd, '.rivet', 'artifacts')
      this.artifactStore = new ArtifactStore(artifactDir, this.config.sessionId)
      const stateManager = new SessionStateManager(this.config.sessionId)
      this.sessionStateManager = stateManager
    }

    this.cacheAdvisor = new CacheAdvisor({
      providerProfile: this.config.providerProfile ?? { cacheType: 'none', persistent: false },
      contextWindow: this.config.contextWindow,
    })
    this.p3 = createP3Integration({
      execute: async (tool, target) => {
        const SAFE_TOOLS = new Set(['read_file', 'grep', 'glob', 'list_dir'])
        if (!SAFE_TOOLS.has(tool)) return ''
        const validated = validatePathSafe(this.cwd, target)
        if (!validated.ok) return ''
        try {
          const params = {
            input: { file_path: validated.path, path: validated.path },
            cwd: this.cwd,
            toolUseId: `spec_${Date.now()}`,
            contextWindow: this.config.contextWindow,
            providerProfile: this.config.providerProfile,
          }
          const result = await this.config.toolRegistry.execute(tool, params)
          return result.content
        } catch { return '' }
      },
    })


    // Physarum + Immune system — construction only, DB reads deferred to warmupMemories() (S9)
    const meridianDb = this.config.meridianIndexer?.getDb()
    const physarum = new PhysarumEngine(meridianDb)
    this.immuneHook = new ImmuneHook({ physarum, stigmergy: this.stigmergyStore, notebook: this.p3?.notebook })
    this.physarumForWarmup = physarum
    this.meridianDbForWarmup = meridianDb

    this.runtimeHooks = this.config.runtimeHooks ?? this.createRuntimeHooksPipeline()
    this.perception = new TurnPerceptionController({
      cwd: this.cwd,
      maxTurns: this.config.maxTurns,
      runtimeHooks: this.runtimeHooks,
      telemetryWriter: this.telemetryWriter,
      getRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      getProviderDegradationRatio: () => this.config.providerHealth?.getDegradationRatio() ?? 0,
      // Hook injections are pseudo-user messages: wrap as <system-reminder>
      // so PromptEngine doesn't treat them as user boundaries (cache break).
      addUserMessage: message => { this.session.addUserMessage(wrapSystemReminder(message)) },
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      setReasoningEffort: effort => { this.setReasoningEffort(effort) },
      getFingerprint: () => this.config.promptEngine.getFingerprint(),
    })
    this.intent = new TurnIntentController({
      depositDeadEnd: deposit => this.stigmergyStore.deposit(deposit),
      addUserMessage: message => { this.session.addUserMessage(wrapSystemReminder(message)) },
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
      getCwd: () => this.cwd,
      advisoryBus: this.advisoryBus,
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      providerProfile: this.config.providerProfile,
      primaryClient: this.config.primaryClient,
      compactEnabled: this.config.compact.enabled,
      pressureMonitor: this.pressureMonitor,
      getTrajectoryEntries: () => this.trajectory.getEntries(),
      getStreamedText: () => this.streamedText,
      refreshLedger: () => { this.contextInjection.refreshLedger() },
      cacheAdvisor: this.cacheAdvisor,
      getStanceSummary: () => this.stanceTally.render(),
      persistMemories: memories => {
        const persist = this.persist
        if (!persist) return
        const createdAt = Date.now()
        for (const mem of memories) {
          persist.appendMemory({
            text: `[${mem.kind}] ${mem.text}`,
            source: 'compact',
            createdAt,
          })
        }
      },
      getAbortSignal: () => this.abortController?.signal,
      getActiveContract: () => this.taskContract,
    })
    // 在 AgentLoop 构造时立即设置 prefixOverhead，关闭 UI 启动到 maybeCompact 之间的窗口。
    // 否则首次响应前 GlanceBar 显示 ctx 0%、◧ 0/1.0M（数据未接入而非真的 0%）。
    this.compaction.ensurePrefixOverhead()
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController()
    this.toolExecution = this.createToolExecutionController()
    this.planTraceCoordinator = createPlanTraceCoordinator(this)
    this.compactBoundaryCoordinator = createCompactBoundaryCoordinator(this)
    this.turnOrchestrator = createTurnOrchestrator(this)
    this.reasoningEffort = createReasoningEffortController(this)
    this.intentRoute = createIntentRetrievalRouteController(this)
    this.antiAnchoring = createAntiAnchoringController(this)
    this.modelRoutingShadow = createModelRoutingShadowController(this)
    this.prewarmController = createPrewarmController(this)
    
    // 初始化 SessionPersist 用于 fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId)

      // P1: Initialize session metadata with model info
      this.persist.initMetadata({
        model: this.config.promptEngine.getModel(),
        cwd: this.cwd,
      })
      // R1: record cwd (cross-cwd resume gate) and reset cleanExit — the session
      // is now live, so a subsequent crash should be recoverable and a later
      // clean exit must re-mark it. Runs for both fresh and resumed sessions.
      this.persist.updateMetadata({ cwd: this.cwd, cleanExit: false })

      // P0-1: Mirror every in-memory message change to disk so non-/exit
      // shutdowns (Ctrl+C, crash, network drop) don't lose the session.
      attachSessionPersistListener({ session: this.session, persist: this.persist })
    }
  }

  private createTurnStreamController(): TurnStreamController {
      return createTurnStreamController(this);
  }

  private createTurnCompletionController(callbacks?: AgentCallbacks): TurnCompletionController {
      return createTurnCompletionController(this, callbacks);
  }

  private createToolExecutionController(): ToolExecutionController {
      return createToolExecutionController(this);
  }
  private createRuntimeHooksPipeline(): RuntimeHookPipeline {
      return new RuntimeHookPipeline(createDefaultRuntimeHooks({
        stigmergyDeposit: deposit => this.stigmergyStore.deposit(deposit),
        stigmergyQuery: () => this.stigmergyStore.query(),
        getEvidenceState: () => this.evidence.getState(),
        setLoadedPheromones: pheromones => { this.loadedPheromones = mapQueriedPheromones(pheromones) },
        recordStance: signal => this.stanceTally.record(signal),
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
        getPhysarumShadowStats: () => this.getPhysarumShadowStats(),
        getDomainId: () => this.sessionDomain?.id ?? null,
        getFileObservations: () => this.config.contextClaimStore?.listClaims({ kind: ['file_observation'] }) ?? [],
        antiAnchoring: normalizeAntiAnchoringConfig(this.config.antiAnchoring),
        getInitialUserMessage: () => this.initialUserMessage,
        callAntiAnchoringSeedModel: prompt => this.antiAnchoring.callSeedModel(prompt),
        songlineEnabled: this.config.songlineEnabled,
        getTaskSummary: this.config.taskLedger ? () => this.config.taskLedger!.getSummary() : undefined,
        setCycleClose: this.config.sessionRegistry
          ? (sessionId, closeHash) => this.config.sessionRegistry!.setCycleClose(sessionId, closeHash)
          : undefined,
        constellationEnabled: this.config.sessionId !== undefined,
        constellationCwd: this.cwd,
        getConstellationPendingMark: () => this.pendingLeaveMark,
        getConstellationNumericId: () => this._sessionNumericId,
        hearthObserveEnabled: this.config.hearthObserveEnabled,
        getAnchorGraph: () => this.antiAnchoring.buildAnchorGraph(),
        getPrevAnchorGraphHash: () => this.prevAnchorGraphHash,
        setPrevAnchorGraphHash: (hash: string) => { this.prevAnchorGraphHash = hash },
        getStreamedText: () => this.streamedText,
        getPrevStreamedText: () => this.prevStreamedText,
        setPrevStreamedText: (text: string) => { this.prevStreamedText = text },
        getPrevCycleOpen: this.config.sessionRegistry && this.config.sessionId
          ? () => this.config.sessionRegistry!.getLastCycleClose()
          : undefined,
        getPrevSessionCycleClose: this.config.sessionRegistry
          ? () => this.config.sessionRegistry!.getLastCycleClose()
          : undefined,
        ...(this.config.sessionId ? {
          dream: {
            cwd: this.cwd,
            sessionId: this.config.sessionId,
            getDecisions: () => this.decisions,
            getTrajectory: () => this.trajectory.getEntries(),
          },
        } : {}),
        meridianIndexer: this.config.meridianIndexer,
        physarumFileAccess: {
          getPhysarum: () => this.immuneHook.getPhysarum(),
          onPredictions: batch => {
            this.p3.enqueuePhysarumFilePredictions({
              afterToolName: batch.afterToolName,
              predictions: batch.predictions,
            })
            void batchPrewarm(
              this.cwd,
              batch.predictions.map(prediction => prediction.file),
              this.prewarm,
            ).catch(() => {})
          },
        },
        autoDelegate: (this.config.coordinatorRef && this.config.autoDelegateEnabled) ? {
          coordinator: () => this.config.coordinatorRef?.() ?? null,
          getTaskContract: () => this.getTaskContract(),
          getSensorium: () => this.sensorium,
        } : undefined,
        memoryLearning: {
          cwd: this.cwd,
          sessionId: this.config.sessionId,
          getUserMessage: () => this.initialUserMessage,
          getStreamedText: () => this.streamedText,
        },
        userHooksBridge: {
          cwd: this.cwd,
          sessionId: this.config.sessionId,
          getTurn: () => this.session.getTurnCount(),
        },
        advisoryBus: this.advisoryBus,
      }))
  }
  buildRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
      return buildRuntimeSnapshot(this, extra);
  }


  /** Capture an agent's departure mark — sealed into the starmap at session close. */
  captureLeaveMark(mark: import('../tools/types.js').LeaveMarkInput): void {
    this.pendingLeaveMark = mark
  }

  /** The pending departure mark, if the agent left one this session. */
  getPendingLeaveMark(): import('../tools/types.js').LeaveMarkInput | null {
    return this.pendingLeaveMark
  }

  /** Write a constellation milestone when plan_close applies successfully. */
  handlePlanClosed(input: import('../tools/types.js').PlanClosedInput): void {
    try {
      const domain = this.sessionDomain?.id ?? ''
      const numericId = this._sessionNumericId ?? undefined
      const mark = buildAgentMark({ symbol: VOID_SYMBOL, domain, numericId })
      const summary = `plan closed: ${input.planFile} [${input.tasks}] ${input.deliveryState}`
      const milestone = buildDepartureMilestone({
        sessionId: this.config.sessionId ?? 'anon',
        agentMark: mark,
        domain,
        summary,
        type: 'milestone',
        tags: ['plan-close'],
      })
      appendMilestone(this.cwd, milestone)
    } catch {
      // Milestone write is best-effort; must not disrupt the tool flow.
    }
  }

  /** U6/C1: seed the execution trace from the agent's first todo write.
   *  withPlanSteps is idempotent — only the first non-empty write populates
   *  the baseline; later status-update writes are a no-op on the trace. */
  capturePlanSteps(descriptions: string[]): void {
    this.planTraceCoordinator.capturePlanSteps(descriptions)
  }

  /** U6: build a StepResult from the tool events recorded for a given turn. */
  private buildStepResultFromTurn(turn: number): StepResult | null {
    return this.planTraceCoordinator.buildStepResultFromTurn(turn)
  }

  /** U6: turn-boundary deviation check. Reads the latest convergence result +
   *  no-tool counter + most recent step result, detects deviation, applies a
   *  course correction, and refreshes the replan/trace prompt surfaces. No-op
   *  until the trace has steps (i.e. the agent has produced a todo plan). */
  runReplanCheck(): void {
    this.planTraceCoordinator.runReplanCheck()
  }

  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string): void {
      recordToolHistory(this, name, input, isError, result);
      // F-fix (session 803d897d): field habituation moves discipline text out of
      // focus after ~4 turns while a heavy turn can run 20+ tool calls. Re-anchor
      // a one-line discipline summary through the advisory bus every N calls —
      // appendix-rendered, cache-safe, no frozen-prefix changes.
      this.toolCallsSinceReanchor++
      if (this.toolCallsSinceReanchor >= DISCIPLINE_REANCHOR_INTERVAL) {
        this.toolCallsSinceReanchor = 0
        this.advisoryBus.submit(disciplineReanchorEntry())
      }
  }

  private recordModelRoutingShadow(currentSensorium: Sensorium, efe: EFEComponents): void {
    this.modelRoutingShadow.record(currentSensorium, efe)
  }

  private bindSessionDomain(taskDescription: string): void {
    if (this.sessionDomain !== undefined) return
    this.sessionDomain = isStarSoulEnabled() ? buildActiveDomain(taskDescription) : null
    this.config.promptEngine.setActiveDomain(this.sessionDomain)
  }

  abort(): void {
    this._turnInterruptCount++
    this._pendingAbort = true
    this.abortController?.abort()
    // NOTE: killAll() removed — it was a global hammer that killed processes
    // from ALL AgentLoop instances, not just this one (中间层 #1).
    // 范围化进程清理由「协作式取消」实现，而非全局硬锤：abortController 是
    // 本实例独有的，abort() 翻转其信号 → 经 tool-pipeline 透传到本实例正在跑的
    // 工具（bash/run_tests 已监听 params.abortSignal，立即 killProcessTree 自身子进程）。
    // 因信号按实例隔离，中止本实例绝不会波及另一实例的子进程（双实例隔离）。
    // 进程的最终兜底清理仍由 main.tsx 退出路径的 killAllSync() 负责。
  }

  /**
   * Synchronously persist pending debounced memory stores. Called from the exit
   * path (main.tsx shutdownCallback) so deposits inside the 200ms debounce
   * window survive Ctrl+C / shutdown. Best-effort: never throw on the exit path.
   */
  flushStigmergySync(): void {
    try {
      this.stigmergyStore.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
    try {
      this.config.domainKnowledgeStore?.flushSync()
    } catch {
      // exit-path persistence is best-effort; a failure must not block exit
    }
  }

  /**
   * System-initiated abort (hard-stall watchdog) — breaks a wedged turn
   * WITHOUT incrementing `_turnInterruptCount`. That counter feeds the
   * recovery-trigger's "repeatedly interrupted" classification (see
   * refreshReliabilityDecision); a watchdog stall-recovery is not a user
   * interrupt and must not be mislabeled as one, especially when combined
   * with a genuine earlier interrupt in the same run.
   */
  private abortStalledTurn(): void {
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  /** Sync plan-mode state into config so tool-pipeline reads it */
  syncPlanModeToConfig(): void {
    this.config.planModeState = this.planModeState
    this.config.promptEngine.setPlanModeState(this.planModeState)
  }

  setReasoningEffort(effort: import('./auto-reasoning.js').ReasoningEffort): void {
    this.reasoningEffort.set(effort)
  }

  shadowEffortTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    this.reasoningEffort.shadowTelemetry(ruleBaseline, overrides)
  }

  getEffortDelta(): number | null {
    return this.reasoningEffort.getDelta()
  }

  getReasoningEffort(): import('./auto-reasoning.js').ReasoningEffort | undefined {
    return this.reasoningEffort.get()
  }

  updateSessionMemory(block: string): void {
    this.config.promptEngine.updateSessionMemory(block)
  }

  updateTools(): void {
    this.config.promptEngine.updateTools(this.config.toolRegistry.getDefinitions())
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

  /** @deprecated Mode is now auto-detected from message content via isActionableTurn. */
  setPromptMode(_mode: string): void {
    // No-op: mode detection is automatic. Kept for backward compat with slash commands.
  }

  /** @deprecated Always returns 'task' — chat/task binary no longer exists. */
  getPromptMode(): string {
    return 'task'
  }

  /** Get the currently active star domain (null = no domain, undefined = not yet resolved). */
  getSessionDomain(): ActiveStarDomain | null | undefined {
    return this.sessionDomain
  }

  /** Manually set the active star domain. Pass null to disable, or a valid ActiveStarDomain. */
  setSessionDomain(domain: ActiveStarDomain | null): void {
    this.sessionDomain = domain
    this.config.promptEngine.setActiveDomain(domain)
  }

  /** Reset domain to undefined so the next run() will auto-detect from user input. */
  resetSessionDomain(): void {
    this.sessionDomain = undefined
    this.config.promptEngine.setActiveDomain(undefined)
  }

  getLatestPheromones() { return this.loadedPheromones }

  /** Expose MeridianIndexer for /index command */
  getIndexer() { return this.config.meridianIndexer ?? null }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' {
    // 精确指纹（同 hash 重复）+ bash 命令类指纹（sed/head/tee 变体归并）取最严级别。
    return combineDoomLoopLevels(
      getDoomLoopLevel(this.traceStore.toolFingerprints),
      getClassDoomLoopLevel(this.traceStore.bashClassFingerprints ?? []),
    )
  }

  getReliabilityDecision(): ReliabilityDecision | null { return this.latestReliabilityDecision }

  private sessionPersistPath(): string | undefined {
    return this.persist?.getFilePath()
  }

  private refreshReliabilityDecision(): void {
    this.latestResourceSnapshot = this.resourceSensor.sample(this.sessionPersistPath())
    const disk = this.latestResourceSnapshot.disk
    const trigger = classifyRecoveryTrigger({
      interrupt: {
        interruptCountThisTurn: this._turnInterruptCount,
        hasPendingTools: this.detectPendingTools(),
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
      integrity: this.computeSessionIntegrity(),
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

  /** 中#5: Check for tool_calls that have no matching tool_result. */
  private detectPendingTools(): boolean {
    const msgs = this.session.getMessages()
    const pendingIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) pendingIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        pendingIds.delete(msg.tool_call_id)
      }
    }
    return pendingIds.size > 0
  }

  /** 中#5: Compute session integrity snapshot for recovery trigger. */
  private computeSessionIntegrity() {
    const msgs = this.session.getMessages()
    const toolCallIds = new Set<string>()
    const toolResultIds = new Set<string>()
    for (const msg of msgs) {
      if (msg.role === 'assistant' && msg.tool_calls) {
        for (const tc of msg.tool_calls) {
          if (tc.id) toolCallIds.add(tc.id)
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResultIds.add(msg.tool_call_id)
      }
    }
    return {
      orphanToolUseCount: [...toolCallIds].filter(id => !toolResultIds.has(id)).length,
      orphanToolResultCount: [...toolResultIds].filter(id => !toolCallIds.has(id)).length,
      wasRepaired: false,
      syntheticResultsInserted: 0,
      messageCount: msgs.length,
    }
  }

  requestThetaCheck(reason: string): void {
      if (this.config.thetaCheckDisabled) return
      requestThetaCheck(this, reason);
  }

  /** Physarum provider health: feed stream outcomes into the tracker.
   *  Success slowly warms the provider; failure rapidly cools it (4x asymmetry).
   *  Degradation ratio is consumed by sensorium stability; cold tiers are
   *  skipped by coordinator worker routing. */
  recordProviderOutcome(ok: boolean): void {
    const health = this.config.providerHealth
    const providerId = this.config.providerName
    if (!health || !providerId) return
    health.registerProvider(providerId)
    if (ok) health.recordSuccess(providerId)
    else health.recordFailure(providerId)
  }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

  /** Latest free-energy policy signals (EFE + sensorium) for downstream routing. */
  getPolicySignals(): { efe: EFEComponents; sensorium: Sensorium } | undefined {
    return this.latestPolicySignals
  }

  /** Enter plan mode — only read-only tools allowed */
  enterPlanMode(): void { this.planModeState = 'planning' }

  /** Exit plan mode — user approved, all tools allowed */
  exitPlanMode(): void { this.planModeState = 'off' }

  /** Get current plan mode state */
  getPlanModeState(): PlanModeState { return this.planModeState }

  getPrewarmStats(): { hits: number; misses: number; hitRate: number } { return this.prewarm.stats() }

  getPhysarumShadowStats(): PhysarumShadowStats {
    return getPhysarumShadowStatsFromDb(this.meridianDbForWarmup)
  }

  getCacheDiagnostic(): string | null { return this.lastCacheDiagnostic }

  refreshCacheDiagnostic(turn: number): void {
    this.lastCacheDiagnostic = this.compaction.refreshCacheDiagnostic(turn)
  }

  getLedger() { return this.session.getContextLedger() }

  getCognitiveSnapshot(): CognitivePhaseSnapshot | undefined { return this.latestCognitiveSnapshot }

  getTaskContract(): TaskContract | undefined { return this.taskContract }

  /** 获取持久化的任务列表（从 Assistant 回复中提取），用于 TUI 固定显示和多轮回溯 */
  getTaskList() { return this.sessionStateManager?.getTaskList() ?? [] }

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
      volatilePayloadReport: this.config.promptEngine.getVolatilePayloadReport(this.recentToolHistory),
      cacheAdvisor: this.cacheAdvisor.getDiagnostic() }
  }

  async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(),
      { emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) } }))
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }
    try { this.immuneHook.getPhysarum().save() } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveMistakeEntries(this.p3.notebook.getAllEntries())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveToolPatternMinerSnapshot(this.p3.miner.exportSnapshot())
    } catch { /* non-critical */ }
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) {
        db.saveBanditState('bandit:reasoning_effort', this.p3.serializeEffortBandit())
        db.saveBanditState('bandit:model_style', this.p3.serializeBandit())
        db.saveBanditState('p3:plan_cache', this.p3.serializePlanCache())
      }
    } catch { /* non-critical */ }
    try {
      const handoffText = this.compaction.buildSessionHandoff()
      const sp = this.persist
      if (sp) {
        sp.writeHandoff(handoffText)
        const domainId = this.sessionDomain?.id
        if (domainId) sp.updateMetadata({ domain: domainId })
      }
    } catch { /* ignore */ }
  }

  private async startFsWatcher(): Promise<void> {
    try {
      await this.fsWatcher?.start()
    } catch {
      // fs.watch is an opportunistic external signal; unavailable watchers must not block turns.
    }
  }

  stopFsWatcher(): void {
    this.fsWatcher?.stop()
    this.latestFsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  }

  async run(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    // Re-entry guard: prevent concurrent agent.run() calls.
    // React strict mode or rapid re-submits could trigger handleSubmit
    // while a previous run is still in-flight, corrupting SessionContext.
    if (this._running) {
      debugLog('[agent] run() called while already running — skipping duplicate')
      return
    }
    this._running = true
    // Eager abort controller: created synchronously before any await so an
    // Esc/Ctrl+C during warmupMemories()/intent-routing aborts a live signal
    // instead of a no-op. Pending latch is cleared for this fresh run.
    this._pendingAbort = false
    this.abortController = new AbortController()
    try {
      await this._runInner(userInput, callbacks, images)
    } finally {
      this._running = false
    }
  }

  /** Load cross-session history off the construction path (S9). Idempotent. */
  async warmupMemories(): Promise<void> {
    if (this.memoriesWarmed) return
    this.memoriesWarmed = true
    const db = this.meridianDbForWarmup
    if (!db) return
    loadSessionMemories({
      db,
      physarum: this.physarumForWarmup,
      immuneHook: this.immuneHook,
      p3: this.p3,
    })
  }

  /**
   * T2-02 Track A2: Apply bandit delta to a base reasoning effort.
   *
   * Wired into the live effort selection path. Protected by three gates:
   *   1. effortBanditEnabled flag (default false) — checked in getEffortDelta()
   *   2. Consistency-promotion gate (totalPulls ≥ 30, agreement ≥ 0.8)
   *   3. reasoningFloor still enforced (resolveEffortDelta clamp)
   *
   * When any gate is closed, returns baseEffort unchanged — zero behavior delta.
   */
  applyEffortDelta(baseEffort: string): string {
    return this.reasoningEffort.applyDelta(baseEffort)
  }

  /**
   * Step 6a: Per-run initialization — warmup, heartbeat, state resets,
   * worktree detection, session split, user message, task contract.
   *
   * Returns the heartbeat (for cleanup) and the wrapped callbacks (which
   * the caller must use for the rest of the run).
   */
  async initializeRun(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<{ heartbeat: TurnHeartbeat, wrappedCallbacks: AgentCallbacks, actionable: boolean, turnMode: TurnMode }> {
    await this.warmupMemories()
    // The controller is created eagerly in run() before any await, so an abort
    // fired during warmup is honored (not discarded). Only create one here if a
    // caller invoked the loop outside run().
    this.abortController ??= new AbortController()
    if (this._pendingAbort) {
      // Interrupt arrived during the warmup window — keep the count and ensure
      // the (already-aborted) controller stays aborted so the turn loop bails.
      this.abortController.abort()
    } else {
      this._turnInterruptCount = 0
    }
    await this.startFsWatcher()
    // P7: heartbeat watchdog — surfaces "still working" signal during long
    // silent operations so the UI doesn't appear frozen and users don't
    // interrupt the agent mid-task. ALSO acts as a watchdog with teeth: if
    // silence exceeds hardStallMs (turn-boundary blind spot — postTurn hooks /
    // compaction / prewarm hang with no abort cooperation), it aborts the turn
    // so the loop's rejectOnAbort races break out instead of freezing forever.
    const heartbeat = new TurnHeartbeat({
      silentMs: 20_000,
      repeatMs: 15_000,
      hardStallMs: 240_000,
      onHeartbeat: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `still working — last activity: ${lastActivity} (${seconds}s ago)`,
        })
      },
      onHardStall: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        debugLog(`[watchdog] hard stall after ${seconds}s (last activity: ${lastActivity}) — aborting wedged turn`)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `recovering — turn stalled ${seconds}s at "${lastActivity}", aborting`,
        })
        this.abortStalledTurn()
      },
    })
    callbacks = wrapCallbacksWithHeartbeat(callbacks, heartbeat)
    heartbeat.start()
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController(callbacks)
    this.trajectory.reset()
    this.decisions = []
    this.traceStore = createTraceStore()
    this.predictionAccumulator = createPredictionAccumulator()
    this.initialUserMessage = userInput
    // Reset accumulations from previous run
    this.thinkingOnlyRetries = 0
    this.lastThinkingContent = ''
    this.consecutiveNoToolTurns = 0
    this.lastTurnTextFingerprint = ''
    this.evidence.reset()
    this.repairHintTracker = new RepairHintTracker()
    this.contextInjection.reset()
    this.recentTextFingerprints = []
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

    // Detect worktree reality: compare injected git context with actual worktree state
    try {
      const ctx = await getGitInjectedContext(this.cwd)
      const injected: InjectedWorktreeContext | undefined = ctx
        ? { branch: ctx.branch, head: ctx.head }
        : undefined
      const reality = await detectWorktreeReality(this.cwd, injected)
      this.config.promptEngine.setWorktreeReality(reality)
    } catch {
      // Detection failure must not crash AgentLoop — clear stale warning
      this.config.promptEngine.setWorktreeReality(null)
    }

    this.bindSessionDomain(userInput)
    this.contextInjection.recordUserInputClaims(userInput)
    this.contextInjection.refreshPlaybookLessons(userInput)

    // Phase 2.3: Proactive session split — MUST run BEFORE addUserMessage.
    await this.compactBoundaryCoordinator.preUserMessageSplit()

    // History invariant probe: a new run must start with the previous turn
    // answered. A trailing user message (or a thinking-only assistant with
    // empty content and no tool_calls) means the previous reply was never
    // persisted — the exact precondition for the "re-answers the previous
    // turn" bug. Log loudly so recurrences are diagnosable from debug logs.
    {
      const tailMsgs = this.session.getMessages()
      const tail = tailMsgs[tailMsgs.length - 1]
      if (tail && (
        tail.role === 'user' ||
        (tail.role === 'assistant' && !tail.content && !tail.tool_calls)
      )) {
        debugLog(`[history-invariant] run starts with unanswered tail: role=${tail.role} msgCount=${tailMsgs.length} — previous assistant reply was not persisted; model may re-answer the previous turn`)
      }
    }

    this.session.addUserMessage(userInput, images)
    const turnMode = classifyTurnMode(userInput, this.taskContract)
    const actionable = turnMode !== 'chat'
    this.config.promptEngine.setActionableTurn(actionable)

    if (turnMode === 'task') {
      this.taskContract = extractTaskContract(userInput, this.session.getTurnCount())
    } else if (turnMode === 'followUp') {
      // Inherit active contract — no new extraction
    } else if (!this.taskContract || this.taskContract.status === 'ready_to_deliver') {
      this.taskContract = undefined
    }

    await this.intentRoute.buildForTurn(userInput, actionable, turnMode)

    // Classify task dependency depth for TDD strategy / verifier selection
    if (this.taskContract && actionable) {
      const routeKinds = this._lastRetrievalRoute?.taskKinds
      this._taskDepthLayer = classifyTaskDepth(this.taskContract, undefined, routeKinds)
      this.config.promptEngine.setTaskDepthLayer(this._taskDepthLayer)
      this._planMethodology = classifyPlanMethodology(this.taskContract, this._taskDepthLayer)
      this.config.promptEngine.setPlanMethodology(this._planMethodology)
      // U6: open a fresh execution trace for a new task (or a changed contract).
      if (this._taskDepthLayer) {
        this.planTraceCoordinator.openTrace(this.taskContract.id, this._taskDepthLayer)
      }
    } else {
      this._taskDepthLayer = undefined
      this._planMethodology = undefined
      this.config.promptEngine.setTaskDepthLayer(undefined)
      this.config.promptEngine.setPlanMethodology(undefined)
      // U6: no active task — drop any prior trace + clear its prompt surfaces.
      this.planTraceCoordinator.closeTrace()
    }

    this.config.promptEngine.setSkillAdvisoryBlock(skillRegistry.renderDiscoveryBlock(userInput))
    this.config.promptEngine.setCrossSessionMemoryBlock(renderMemoryBlock(this.cwd, userInput))
    this.config.promptEngine.setMentionContextBlock(renderMentionContext(parseMentions(userInput)))

    this.config.promptEngine.setPlanCacheAdvisory(
      turnMode === 'task' ? renderPlanCacheAdvisory(this.p3.planCacheSuggest(userInput)) : null,
    )

    if (this.config.autoReasoning && turnMode === 'task') {
      const ruleEffort = selectReasoningEffort(userInput, this.config.reasoningFloor)
      const banditAdjusted = this.applyEffortDelta(ruleEffort) as import('./auto-reasoning.js').ReasoningEffort
      this.config.reasoningEffort = banditAdjusted
      this.config.client.setReasoningEffort?.(banditAdjusted)
      this.shadowEffortTelemetry(ruleEffort)
    }
    return { heartbeat, wrappedCallbacks: callbacks, actionable, turnMode }
  }

  /**
   * Step 6b: Per-turn compaction — session split, maybeCompact, stale round,
   * heap-driven forced compaction. Returns the result for the caller to
   * handle abort logic and userMessageConsumed propagation.
   */
  /**
   * Step 6c: Per-turn perception — pressure check, sensorium computation,
   * season classification, phase class wiring, and contract status advancement.
   * Pure data transformation with no control flow (no return/continue).
   */
  /**
   * Step 6d: Convergence detection — multi-signal stagnation check before
   * the API call. Level 2+ injects guidance; Level 3 forces session split
   * or abort. Returns the action for the caller to handle control flow.
   */
  /**
   * Step 6e: Cognitive prep — sycophancy trap, CVM cognitive ledger,
   * projection building, and CVM overhead tracking.
   * Pure data transformation with no control flow.
   */
  /**
   * Step 6f: Build turn request — intent evaluation, repair hint injection,
   * reliability decision, context ceiling enforcement, cross-session event
   * sync, and OAI request building. Returns the action and request.
   */
  async buildTurnRequest(
    turn: number,
    currentStrategy: StrategyProfile,
    currentSensorium: Sensorium,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'veto' | 'abort'
    request?: OaiChatRequest
  }> {
    let _tb = Date.now()
    const intentResult = await this.intent.evaluate({
      strategy: currentStrategy,
      vigor: this.vigorState,
      sensorium: currentSensorium,
      pheromones: this.loadedPheromones,
      pressureResult,
      recentToolHistory: this.recentToolHistory,
      onIntentPreview: callbacks.onIntentPreview,
    })
    debugLog(`[turn-boundary] turn=${turn} intent: ${Date.now() - _tb}ms`)
    if (intentResult === 'veto') {
      callbacks.onPhaseChange?.('intent-veto', { reason: 'user vetoed intent', suggestion: 're-plan before tool use' })
      callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
      return { action: 'veto' }
    }

    // Pass 5: adaptive repair hint injection
    this.contextInjection.refreshRepairHint()

    // Anti-habituation: staleness gate — fire when session is long and no objections raised
    this.turnsSinceLastObjection++
    if (turn >= STALENESS_GATE_TURN_THRESHOLD && this.turnsSinceLastObjection >= STALENESS_GATE_QUIET_WINDOW) {
      this.advisoryBus.submit(stalenessGateEntry(this.turnsSinceLastObjection))
    }
    // Anti-habituation: vigor-low refresh — wake up when execution energy is depleted
    if (this.vigorState.tonic < 0.3) {
      this.advisoryBus.submit(vigorLowEntry())
    }

    // A1: flush advisory bus into prompt engine (unified corrective guidance)
    this.config.promptEngine.setHarnessAdvisoryBlock(this.advisoryBus.render())

    this.refreshReliabilityDecision()

    _tb = Date.now()
    await this.compaction.enforceContextCeiling()
    debugLog(`[turn-boundary] turn=${turn} enforceContextCeiling: ${Date.now() - _tb}ms`)
    // A2: enforceContextCeiling can trigger LLM compact (30s timeout).
    if (this.abortController!.signal.aborted) {
      if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
      callbacks.onAbort()
      return { action: 'abort' }
    }
    this.contextInjection.refreshActiveClaims()

    // Read events from other sessions (cache-safe: injected into dynamic appendix only)
    if (this.config.sessionRegistry && this.config.sessionId) {
      const events = this.config.sessionRegistry.consumeEvents(this.config.sessionId, this.lastSeenEventId)
      let appendix = ''
      if (events.length > 0) {
        this.lastSeenEventId = Math.max(...events.map(e => e.id))
        appendix = formatEventsForAppendix(events)
      }
      // P2b: inject active cross-session claims so the LLM can proactively avoid conflicts
      const claims = this.config.sessionRegistry.getActiveClaims(this.config.sessionId)
      if (claims.length > 0) {
        const grouped = new Map<string, string[]>()
        for (const c of claims) {
          const key = c.filePath
          if (!grouped.has(key)) grouped.set(key, [])
          grouped.get(key)!.push(`${c.sessionId}(${c.claimType})`)
        }
        const claimLines = [...grouped.entries()].map(([file, holders]) =>
          `  ${file} — claimed by ${holders.join(', ')}`)
      }
      if (this.persist) {
        const prevHandoff = SessionPersist.loadPrevHandoff(
          this.config.sessionId,
          this.sessionDomain?.id,
        )
        if (prevHandoff) {
          appendix = (appendix ? appendix + '\n' : '') +
            '<prev-session-handoff>\n' + prevHandoff + '\n</prev-session-handoff>'
        }
      }
      this.config.promptEngine.setCrossSessionEvents(appendix || null)
    }
    // Inject session state snapshot into volatile block before building request
    if (this.sessionStateManager) {
      this.config.promptEngine.setSessionState(this.sessionStateManager.renderForVolatile())
    }
    // Pre-refresh git status so buildOaiRequest doesn't return stale cached data
    _tb = Date.now()
    await this.config.promptEngine.refreshGitContextIfNeeded(this.cwd)
    debugLog(`[turn-boundary] turn=${turn} refreshGitContext: ${Date.now() - _tb}ms`)
    const request = this.config.promptEngine.buildOaiRequest(
      this.session.getMessages(),
      this.recentToolHistory,
      this.config.contextWindow,
    )

    return { action: 'proceed', request }
  }

  /**
   * Build and inject the cognitive projection (cognitive-mirror + task-contract
   * + verification-gap + uncertainty + immune hint) into the prompt engine.
   * Reconnected after the loop-split refactor silently orphaned it.
   *
   * Note: the sycophancy trap is intentionally NOT recorded here — it needs a
   * redesign before re-wiring (blind-execution heuristic too coarse). The
   * `sycophancyHint` therefore stays undefined, matching the prior behavior.
   */
  private runCognitivePrep(
    turn: number,
    actionable: boolean,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
  ): void {
    const cognitiveLedger = createCognitiveLedger({
      contract: this.taskContract,
      evidence: this.evidence.getState(),
      trace: this.traceStore,
      turn,
      // 道常无为而无不为：CVM throttle — skip mirror when overhead > 5%
      sensorium: pressureResult.shouldThrottleCvm ? null : this.sensorium,
      strategy: pressureResult.shouldThrottleCvm ? null : this.strategy,
      vigor: pressureResult.shouldThrottleCvm ? null : this.vigorState,
      season: pressureResult.shouldThrottleCvm ? null : this.currentSeason,
      // CVM uncertainty trap: risk level from latest tool assessment
      riskLevel: this.latestRisk.level,
    })
    this.latestCognitiveSnapshot = getCognitivePhaseSnapshot(cognitiveLedger)
    const sycophancyHint = undefined
    const immuneHint = this._lastImmuneHint ? formatImmuneContext(this._lastImmuneHint) : undefined
    this._lastImmuneHint = undefined // consume once
    const projection = actionable ? buildCognitivePromptProjection(cognitiveLedger, { sycophancyHint, immuneHint }) : ''
    this.config.promptEngine.setCognitiveProjection(projection)

    // ── CVM overhead tracking ──
    // 盘古呼吸：CVM 保护的资源（context）也是它消耗的资源。
    // 追踪每次注入的 token 估计，防止认知氧气被自身消耗殆尽。
    // chars / 4 ≈ tokens (crude but fast estimate for overhead ratio)
    if (actionable) {
      const cvmTokenEstimate = Math.ceil(projection.length / 4)
      this.pressureMonitor.recordCvmInjection(cvmTokenEstimate) // Called after setting projection
    }
  }

  async runConvergenceCheck(
    turn: number,
    phaseClass: string,
    assistantResponded: boolean,
    userMessageConsumed: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    action: 'proceed' | 'abort'
  }> {
    const convergenceCheck = evaluateConvergence({
      turn,
      phaseClass: phaseClass as PhaseClass,
      contextWindow: this.config.contextWindow,
      recentToolHistory: this.recentToolHistory,
      evidenceState: this.evidence.getState(),
      toolFingerprints: this.traceStore.toolFingerprints,
      noToolTurnCount: this.consecutiveNoToolTurns,
      textFingerprints: this.recentTextFingerprints,
    })
    this.latestConvergenceResult = convergenceCheck
    debugLog(`[convergence] turn=${turn} score=${convergenceCheck.score.toFixed(2)} level=${convergenceCheck.level} phase=${phaseClass}`)

    if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
      // Level 2: inject user guidance as a system-visible nudge
      callbacks.onPhaseChange?.('convergence-warning', {
        reason: `收敛检测 L${convergenceCheck.level}: ${phaseClass} 阶段 ${turn} 轮未收敛 (score=${convergenceCheck.score.toFixed(2)})`,
        suggestion: convergenceCheck.injectedMessage.slice(0, 200),
      })
      // R4 — externalize the convergence nudge as a structured course-correction
      // so the desktop renders a "改道" card; the injected guidance below is what
      // the agent acts on next, making the cause→effect visible to the user.
      callbacks.onDecisionShift?.({
        source: 'convergence',
        reason: `${phaseClass} 阶段连续 ${turn} 轮未收敛，已提示换一种推进方式`,
        methods: [convergenceCheck.injectedMessage.slice(0, 200)],
        severity: convergenceCheck.level >= 2 ? 'warn' : 'info',
      })
      this.session.addUserMessage(wrapSystemReminder(convergenceCheck.injectedMessage))

      // When convergence is detected AND doom loop is blocked, the agent is
      // likely in a post-completion verification loop. Signal completion
      // instead of letting the model continue alternating between tools.
      // Track 3 合一：能拿到权威门禁（v2）时按真实 GREEN/YELLOW/RED 给指引，
      // 不再让模型自己猜门禁状态。
      if (this.getDoomLoopLevel() === 'blocked' && convergenceCheck.level >= 2) {
        let gateHint = '任务验证循环已检测到。如果交付门禁为 GREEN，请输出最终摘要并结束回合。不再调用工具。'
        try {
          const gate = this.config.deliveryGateV2?.([...this.evidence.getState().filesModified])
          if (gate) gateHint = `任务验证循环已检测到。${buildGateConvergenceHint(gate, this._taskDepthLayer)}`
        } catch { /* gate evaluation must never break convergence handling */ }
        this.session.addUserMessage(wrapSystemReminder(gateHint))
      }
    }

    if (convergenceCheck.shouldForceSplit) {
      // Level 3: force session split to reset context and break the loop
      debugLog(`[convergence] turn=${turn} force-split score=${convergenceCheck.score.toFixed(2)}`)
      if (await this.compaction.trySessionSplit()) {
        // split succeeded — reset turn counter and continue
        debugLog(`[convergence] turn=${turn} split-succeeded`)
      }
    }

    if (convergenceCheck.shouldAbort) {
      const noToolInfo = this.consecutiveNoToolTurns >= 5 ? ` noToolTurns=${this.consecutiveNoToolTurns}` : ''
      debugLog(`[convergence] turn=${turn} abort score=${convergenceCheck.score.toFixed(2)}${noToolInfo}`)
      callbacks.onPhaseChange?.('convergence-abort', {
        reason: `收敛检测 L3 abort: score=${convergenceCheck.score.toFixed(2)}${noToolInfo}`,
      })
      if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
      callbacks.onAbort()
      return { action: 'abort' }
    }

    return { action: 'proceed' }
  }

  async runPerception(
    turn: number,
    estTokens: number,
    actionable: boolean,
    callbacks: AgentCallbacks,
  ): Promise<{
    sensorium: Sensorium
    strategy: StrategyProfile
    phaseClass: string
    pressureResult: import('../context/pressure-monitor.js').PressureResult
  }> {
    // ── StarFlow v2: Sensorium computation ──
    const pressureResult = this.pressureMonitor.check(estTokens, this.session.getTurnCount())
    if (!actionable) {
      this.config.promptEngine.setCognitiveProjection(null)
      this.config.promptEngine.setTaskProgress({ completed: [], current: 'chat-mode', remaining: [], decisions: [] })
    }
    callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })

    // ── Event-loop gap detection ──
    // If >30s elapsed since last tool completion, the event loop may have
    // been blocked. Log a warning to help diagnose session freeze bugs.
    if (this.lastToolCompleteTime > 0) {
      const gapMs = Date.now() - this.lastToolCompleteTime
      if (gapMs > 30_000) {
        debugLog(`[event-loop] WARNING: ${(gapMs / 1000).toFixed(1)}s gap since last tool completion (turn ${this.session.getTurnCount()})`)
      }
    }

    const _tb = Date.now()
    const perceptionResult = await this.perception.perceive({
      turn,
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
      emitDecisionShift: (shift) => { callbacks.onDecisionShift?.(shift) },
    })
    this.sensorium = perceptionResult.sensorium
    debugLog(`[turn-boundary] turn=${turn} perceive: ${Date.now() - _tb}ms`)
    this.strategy = perceptionResult.strategy
    this.vigorState = perceptionResult.vigor
    this.thetaState = perceptionResult.thetaState
    this.sensoriumSnapshots = this.perception.getSnapshots()
    const currentSensorium: Sensorium = perceptionResult.sensorium

    // ── 认知季节 — 道德经四章螺旋 ──
    const seasonResult = classifySeason({
      turn,
      doomLevel: this.getDoomLoopLevel(),
      recentCompactTurn: this.lastCompactTurn,
      sensoriumStability: currentSensorium.stability,
    })
    this.currentSeason = seasonResult.season

    // ── Embodied Cognition: affordance-gated tool selection hint ──
    const affordanceState: AffordanceState = {
      sensorium: currentSensorium,
      vigor: this.vigorState,
      thetaPhase: getThetaPhase(this.thetaState),
      season: this.currentSeason,
      workingSetSize: this.evidence.getState().filesModified.size,
      recentToolNames: this.recentToolHistory.map(t => t.tool),
      contractStatus: this.taskContract?.status,
    }
    this.config.promptEngine.setAffordanceHint(renderAffordanceHint(affordanceState) || null)

    // ── Free Energy Engine: EFE-driven policy guidance ──
    // Meridian 结构喂 EFE：探索信息增益由 physarum 图的边疆度估计（Track 1）。
    let structuralEpistemic: number | undefined
    try { structuralEpistemic = this.immuneHook.getPhysarum().structuralEpistemic() } catch { /* graph signal is optional */ }
    const efe = computeEFE(this.predictionAccumulator, this.currentSeason, this.vigorState, currentSensorium, structuralEpistemic)
    this.latestPolicySignals = { efe, sensorium: currentSensorium }
    const affordances = computeAffordanceScores(affordanceState, this.sessionAffordanceAdaptations)
    const policies = selectPolicy(efe, affordances, { topK: 5 })
    this.config.promptEngine.setPolicyGuidance(renderPolicyGuidance(policies, efe) || null)
    this.recordModelRoutingShadow(currentSensorium, efe)

    // ── Adaptive Affordance: periodically recalibrate base affordances from sensorimotor history ──
    if (this.session.getTurnCount() % 10 === 0) {
      try {
        const db = this.config.meridianIndexer?.getDb()
        if (db) {
          this.sessionAffordanceAdaptations = adaptAffordanceFromHistory(toolName => db.getToolSuccessRate(toolName, 20))
        }
      } catch { /* affordance adaptation is non-critical */ }
    }

    // Wire StarPhase → phaseClass for field habituation modulation
    const phaseClass = PHASE_CLASS_MAP[perceptionResult.event.phase] ?? 'plan'
    this.config.promptEngine.setPhaseHint(phaseClass)
    const contractStatus = contractStatusFromPhaseClass(phaseClass)
    if (this.taskContract && contractStatus) {
      const prevStatus = this.taskContract.status
      this.taskContract = advanceContractStatus(this.taskContract, contractStatus, this.session.getTurnCount())

      // TDD Gate: one-shot check on planning→executing transition
      if (prevStatus === 'planning' && this.taskContract.status === 'executing' && !this._lastImmuneHint) {
        const es = this.evidence.getState()
        const tddHint = checkTddGate({
          filesRead: es.filesRead,
          filesModified: es.filesModified,
          isActionable: this.taskContract.isActionable,
        })
        if (tddHint) this._lastImmuneHint = tddHint
      }
    }

    // ── Cognitive projection — build & inject cognitive-mirror + contract +
    // verification-gap + uncertainty + immune hint. Runs last so it sees the
    // freshly-advanced contract status and consumes the TDD-gate immune hint
    // produced above (reproduces the original _runInner step-6e ordering).
    this.runCognitivePrep(turn, actionable, pressureResult)

    return { sensorium: perceptionResult.sensorium, strategy: perceptionResult.strategy, phaseClass, pressureResult }
  }

  async runCompaction(
    turn: number,
    snap: ResourceSensorSnapshot | null,
  ): Promise<{
    compacted: boolean
    shouldAbort: boolean
    userMessageConsumed: boolean
  }> {
    return this.compactBoundaryCoordinator.runCompaction(turn, snap)
  }

  private async _runInner(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    await this.turnOrchestrator.execute(userInput, callbacks, images)
  }

}

