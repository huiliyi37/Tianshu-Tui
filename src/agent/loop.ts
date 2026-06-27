import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { SessionContext } from './context.js'
import { SessionPersist, getSessionDir } from './session-persist.js'
import { attachSessionPersistListener } from './session-persist-listener.js'
import { PrewarmCache } from './prewarm.js'
import { validatePathSafe } from '../tools/path-validate.js'
import { gateToolDefinitions, isExtendedTool } from './tool-tiers.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import { EvidenceTracker } from './evidence.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel, getClassDoomLoopLevel, combineDoomLoopLevels, getDoomLoopThresholds } from './trace-store.js'
import { evaluateConvergence } from './convergence-detector.js'
import type { PhaseClass, ConvergenceResult } from './convergence-detector.js'
import type { PlanExecutionTrace, StepResult } from './plan-execution-trace.js'
import { buildGateConvergenceHint } from './delivery-gate-v2.js'
import { RoutingMetricsCollector } from '../model/routing-metrics.js'
import type { ImportGraph } from './import-graph.js'
import type { PlanModeState } from './plan-mode.js'
import { RepairPipeline } from './repair-pipeline.js'
import { fourHorsemenPass, semanticRepairPass } from './repair-passes.js'
import { ctclSanitizerPass } from './ctcl-sanitizer.js'
import { RepairHintTracker } from './repair-hint.js'
import { TurnCompletionController } from './turn-completion.js'
import { ToolExecutionController } from './tool-execution.js'
import { createPredictionAccumulator } from './prediction-error.js'
import type { PredictionAccumulator, EFEComponents } from './prediction-error.js'
import type { Sensorium } from './sensorium.js'
import type { StrategyProfile } from './sensorium.js'
import { createThetaState } from './star-event.js'
import type { ThetaState } from './star-event.js'
import { RuntimeHookPipeline, createRuntimeHookContext, type RuntimeHookSnapshot } from './runtime-hooks.js'
import { TurnPerceptionController } from './turn-perception.js'
import { TurnIntentController } from './turn-intent.js'
import { ContextInjectionController } from './context-injection.js'
import { CompactionController } from './compaction-controller.js'
import { buildActiveDomain, type ActiveStarDomain } from './star-domain.js'
import { mintNumericId, buildAgentMark, VOID_SYMBOL } from './void-identity.js'
import { buildDepartureMilestone } from '../constellation/milestone.js'
import { appendMilestone } from '../constellation/store.js'
import { ArtifactStore } from '../artifact/store.js'
import { COMPACT_HISTORY_TOOL } from '../compact/recall-marker.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { debugLog } from '../utils/debug.js'
import { TurnStreamController } from './turn-stream.js'
import { type CognitiveSeason } from './cognitive-season.js'
import { createVigorState } from './vigor.js'
import type { VigorState } from './vigor.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { CacheAdvisor } from '../cache/advisor.js'
import type { RecallMetricsSummary } from '../cache/recall-metrics.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { createP3Integration, P3Integration } from './p3-integration.js'
import { ImmuneHook } from './immune-hook.js'
import { AdvisoryBus, DISCIPLINE_REANCHOR_INTERVAL, disciplineReanchorEntry } from './advisory-bus.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
import { getPhysarumShadowStatsFromDb } from '../repo/physarum-shadow-stats.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorSnapshot } from './resource-sensor.js'
import { type PlanMethodology, type TaskContract, type TaskDepthLayer } from '../context/task-contract.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { createStanceTally } from './stance-tally.js'
import { createFailureJournal, type FailureJournal } from './failure-journal.js'
import type { Pheromone } from '../context/stigmergy.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { SensoriumEntry } from './retrospect.js'
import { join } from 'node:path'
import { writeFileSync } from 'node:fs'
import type { ApprovalMode, AgentConfig, AgentCallbacks } from './loop-types.js'
import { recordToolHistory } from "./tool-history-recorder.js";
import { requestThetaCheck } from "./theta-controller.js";
import { createTurnStreamController, createTurnCompletionController, createToolExecutionController, createPlanTraceCoordinator, createCompactBoundaryCoordinator, createTurnOrchestrator, createTurnStepProducer, createReasoningEffortController, createIntentRetrievalRouteController, createAntiAnchoringController, createModelRoutingShadowController, createPrewarmController, createRuntimeHooksPipeline, buildRuntimeSnapshot } from "./loop-factory.js";
import type { TurnStepProducer } from './turn-step-producer.js'
import { ReasoningEffortController } from './reasoning-effort-controller.js'
import { IntentRetrievalRouteController } from './intent-retrieval-route-controller.js'
import { AntiAnchoringController } from './anti-anchoring-controller.js'
import { ModelRoutingShadowController } from './model-routing-shadow-controller.js'
import { PrewarmController } from './prewarm-controller.js'
import { loadSessionMemories } from './session-memory-warmup.js'
import type { PlanTraceCoordinator } from "./plan-trace-coordinator.js";
import type { CompactBoundaryCoordinator } from "./compact-boundary-coordinator.js";
import type { TurnOrchestrator } from "./turn-orchestrator.js";
import { type EffortShadowRecord } from './p3-reward.js'

export type { ApprovalMode, AgentConfig, AgentCallbacks }

/**
 * Build the tiny approved-plan pointer block injected into the dynamic appendix.
 * Carries only slug/title/path — NOT the plan body, which stays the single
 * source of truth on disk at `.rivet/plans/<slug>.md`. The agent reads it on
 * demand and tracks steps via the existing todo mechanism.
 */
export function formatActivePlanPointer(plan: { slug: string; title: string }): string {
  const esc = (s: string) =>
    s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;')
  const slug = esc(plan.slug)
  const title = esc(plan.title)
  return `<active-plan slug="${slug}" title="${title}" path=".rivet/plans/${slug}.md">已批准,正在执行此方案。完整步骤见该文件,需要时用 read_file 查看;开工前先用 todo 列出有序步骤跟踪进度,完成后 plan_close。</active-plan>`
}


export class AgentLoop {
    session!: SessionContext;
    config!: AgentConfig;
  abortController: AbortController | null = null
  /** Turn heartbeat watchdog reference (set in initializeRun, cleared on stop). */
  _turnHeartbeat: import('./turn-heartbeat.js').TurnHeartbeat | null = null
  /** True when the current abort was triggered by the hard-stall watchdog
   *  (not user Esc/Ctrl+C). Read by the UI to render a distinct message. */
  _watchdogAborted = false
  /** Count of user interrupts within the current turn (中#5). */
  _turnInterruptCount = 0
  /**
   * Pending-abort latch: set by abort() so an interrupt fired during the
   * init/warmup window (before the turn loop) is honored rather than lost.
   * Reset at the start of each run().
   */
  _pendingAbort = false
  cwd: string
  evidence: EvidenceTracker
  compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  recentToolHistory: ToolHistoryEntry[] = []
  /** Component C (typecheck-reminder): a .ts/.tsx file was written this session. */
  touchedTsFiles = false
  /** Component C: a real typecheck (tsc/typecheck) has run since the last TS edit.
   *  A new TS edit resets this to false so the reminder re-arms. */
  sawTypecheckThisTask = false
  prewarm = new PrewarmCache(60_000, 50)
  private _running = false
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
  streamedText = ''
  thinkingOnlyRetries = 0
  lastThinkingContent = ''
  consecutiveNoToolTurns = 0
  autoContinueCount = 0
  lastTurnTextFingerprint = ''
  lastTurnThinkingFingerprint = ''
  lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  /** Latest per-turn free-energy signals — consumed by coordinator EFE worker routing. */
  latestPolicySignals?: { efe: EFEComponents; sensorium: Sensorium }
  planModeState: PlanModeState = 'off'
  decisions: string[] = []
  trajectory = new TrajectoryRecorder()
  failureJournal: FailureJournal = createFailureJournal()
  repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  repairHintTracker = new RepairHintTracker()
  traceStore: TraceStore
  harness: TurnHarness
  routingMetrics = new RoutingMetricsCollector()
  importGraph: ImportGraph | null = null
  lastConflictCheckCount = 0
  predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  sessionDomain: ActiveStarDomain | null | undefined
  /** Agent's self-chosen departure mark (leave_mark tool); sealed by the
   *  constellation post-session hook. Null until the agent leaves a mark. */
  pendingLeaveMark: import('../tools/types.js').LeaveMarkInput | null = null
  /** Ephemeral per-session numeric id, minted on first run. Used in welcome
   *  display and passed to buildAgentMark when the agent departs. */
  _sessionNumericId: number | null = null

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
  /** Goal tracker for autonomous long-running tasks. Owned by AgentLoop so that
   *  doom-loop threshold selection (getDoomLoopLevel) and goal-active checks
   *  (isGoalActive) read LOCAL state instead of reaching back into the
   *  orchestrator — breaking the former orchestrator→loop→orchestrator cycle.
   *  The orchestrator reads it via the deps.getGoalTracker getter. */
  private goalTracker: import('./goal-tracker.js').GoalTracker | null = null
  /** U6: autonomous plan execution trace. Created per task (initializeRun), steps
   *  seeded from the first todo write (capturePlanSteps), advanced per tool-turn,
   *  and checked for deviation at each turn boundary. Null outside task context. */
  planTrace: PlanExecutionTrace | null = null
  /** U6: last replan correction injected as a system-reminder — dedup guard so a
   *  persistent deviation doesn't spam an identical nudge every turn. */
  lastReplanInjection = ''
  /** Session-local affordance adaptations — per-session, never mutates global registry */
  sessionAffordanceAdaptations: Record<string, import('./affordance.js').BaseAffordance> = {}
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  prevAnchorGraphHash: string | null = null
  /** Previous turn's streamed assistant text for dedup-guard P5. */
  prevStreamedText: string | null = null
  pressureMonitor: PressureMonitor
  sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  turnBudget: TurnBudget = createTurnBudget(0)
  sensorium: Sensorium | null = null
  strategy: StrategyProfile | null = null
  vigorState: VigorState = createVigorState()
  runtimeHooks: RuntimeHookPipeline
  perception: TurnPerceptionController
  intent: TurnIntentController
  contextInjection: ContextInjectionController
  compaction: CompactionController
  // P2-6 breadcrumb state — lifted from createTurnStreamController closure
  // to instance scope so it survives TurnStreamController recreation at each
  // user-message boundary (turn-step-producer.ts:122). Without this, the diff
  // against cumulative engine counters resets every segment, causing false
  // positives (e.g. toolsUpdated=true on every turn=0) and false negatives
  // (real events masked by the reset).
  prevEngineStats = { volatileSwaps: 0, frozenClamps: 0, frozenFallbackRebuilds: 0, toolsUpdates: 0 }
  prevMsgCount = 0
  prevHitRate: number | null = null
  prevTokenEfficiency: number | undefined = undefined
  /** Estimated context tokens at the end of the previous turn — baseline for
   *  compact attribution (compactPreRatio / compactReclaimed in the cache-log). */
  prevEstTokens = 0
  /** The compact-history artifact most recently produced by a compaction, set in
   *  the onArchive callback and consumed once when the rewrite turn's cache-log
   *  entry is built (loop-factory attaches it as entry.archiveId, then clears). */
  lastArchive: { id: string; turn: number } | null = null
  turnStream: TurnStreamController | null = null
  turnCompletion: TurnCompletionController
  toolExecution: ToolExecutionController
  planTraceCoordinator: PlanTraceCoordinator
  compactBoundaryCoordinator: CompactBoundaryCoordinator
  private turnOrchestrator: TurnOrchestrator
  turnStepProducer: TurnStepProducer
  private reasoningEffort: ReasoningEffortController
  intentRoute: IntentRetrievalRouteController
  antiAnchoring: AntiAnchoringController
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
  thetaState: ThetaState = createThetaState(7)
  artifactStore: import('../artifact/store.js').ArtifactStore | undefined
  sessionStateManager: SessionStateManager | undefined
  stigmergyStore: StigmergyStore
  loadedPheromones: Pheromone[] = []
  readonly stanceTally = createStanceTally()
  lastSeenEventId = 0
  gitChangeRate = 0
  telemetryWriter: TelemetryWriter
  baselineFingerprint: PrefixFingerprint | null = null
  sensoriumSnapshots: SensoriumEntry[] = []
  taskContract?: TaskContract
  latestCognitiveSnapshot?: CognitivePhaseSnapshot
  persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  latestResourceSnapshot: ResourceSensorSnapshot | null = null
  latestReliabilityDecision: ReliabilityDecision | null = null
  fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  currentSeason: CognitiveSeason | null = null
  currentSeasonIntensity: number | null = null
  lastCompactTurn: number | null = null
  _lastRetrievalRoute: import('./intent-retrieval-route.js').RetrievalRoute | null = null
  _taskDepthLayer: TaskDepthLayer | undefined = undefined
  _planMethodology: PlanMethodology | undefined = undefined
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
  /** 逃生口运行时挂载的 EXTENDED 工具名（经 /tools enable 加入）。updateTools 时作为豁免传入。 */
  private readonly mountedExtras = new Set<string>()

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
      this.failureJournal,
    )
    this.pressureMonitor = new PressureMonitor(this.config.contextWindow)
    this.resourceSensor = new ResourceSensor(this.config.resourceSensorOptions)
    this.fsWatcher = this.config.fsWatcherEnabled === false ? null : createFsWatcher({ cwd: this.cwd })
    this.telemetryWriter = createTelemetryWriter(this.cwd, this.config.sessionId)
    const sessionDir = join(getSessionDir(this.cwd), this.config.sessionId ?? 'anon')
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

    this.runtimeHooks = this.config.runtimeHooks ?? createRuntimeHooksPipeline(this)
    this.perception = new TurnPerceptionController({
      cwd: this.cwd,
      maxTurns: this.config.maxTurns,
      runtimeHooks: this.runtimeHooks,
      telemetryWriter: this.telemetryWriter,
      getRuntimeSnapshot: extra => this.buildRuntimeSnapshot(extra),
      getProviderDegradationRatio: () => this.config.providerHealth?.getDegradationRatio() ?? 0,
      // Hook injections are pseudo-user messages: append as SR to the last
      // user message (not a new message entry) to preserve prefix cache.
      addUserMessage: message => { this.session.appendSystemReminder(message) },
      requestThetaCheck: reason => { this.requestThetaCheck(reason) },
      setReasoningEffort: effort => { this.setReasoningEffort(effort) },
      getFingerprint: () => this.config.promptEngine.getFingerprint(),
    })
    this.intent = new TurnIntentController({
      depositDeadEnd: deposit => this.stigmergyStore.deposit(deposit),
      addUserMessage: message => { this.session.appendSystemReminder(message) },
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
    this.config.promptEngine.setOnLessonsRendered(ids => {
      try { this.config.playbookStore?.recordUsage(ids) } catch { /* non-critical */ }
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
        // P3: hot-refresh the session-memory volatile block so memories extracted
        // during compaction are visible in THIS session's prompt — not just the
        // next session. rebuildFrozenBase defers the actual volatileBlock swap to
        // the next user message boundary, and compaction runs at turn 0, so this
        // stays prefix-cache safe. Mirrors the /remember slash-command path.
        try {
          this.config.promptEngine.updateSessionMemory(persist.buildMemoryBlock())
        } catch { /* non-critical: memories are already persisted to disk */ }
      },
      getAbortSignal: () => this.abortController?.signal,
      getActiveContract: () => this.taskContract,
      // Layered archival: persist discarded history as a recallable
      // compact-history artifact. Disk-only write, never touches the prefix.
      archiveHistory: async (input) => {
        const store = this.artifactStore
        if (!store) return null
        try {
          return await store.save({
            tool: COMPACT_HISTORY_TOOL,
            target: input.target,
            rawContent: input.rawContent,
            summary: input.summary,
            sections: input.sections,
          })
        } catch {
          return null
        }
      },
      // Recall observability: register the archive turn so recall turn-distance
      // can be computed when the model later read_sections this artifact.
      onArchive: (artifactId, turn) => {
        try { this.cacheAdvisor.registerArchive(artifactId, turn) } catch { /* non-critical */ }
        // Stash for the cache-log: the rewrite turn's entry attaches this id so
        // compaction necessity can be correlated with later recalls (consume-once).
        this.lastArchive = { id: artifactId, turn }
      },
      // Optional disaster-recovery snapshot of the full pre-compaction transcript.
      backupTranscript: (messages, turn) => {
        const persist = this.persist
        if (!persist) return
        try {
          const path = join(persist.getBackupDir(), `pre-compact-${turn}.jsonl`)
          const body = messages.map(m => JSON.stringify(m)).join('\n') + '\n'
          writeFileSync(path, body, 'utf-8')
        } catch {
          // Snapshot is best-effort; never block compaction.
        }
      },
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
    this.turnStepProducer = createTurnStepProducer(this)
    this.reasoningEffort = createReasoningEffortController(this)
    this.intentRoute = createIntentRetrievalRouteController(this)
    this.antiAnchoring = createAntiAnchoringController(this)
    this.modelRoutingShadow = createModelRoutingShadowController(this)
    this.prewarmController = createPrewarmController(this)
    
    // 初始化 SessionPersist 用于 fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId, this.cwd)

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

  createTurnStreamController(): TurnStreamController {
      return createTurnStreamController(this);
  }

  createTurnCompletionController(callbacks?: AgentCallbacks): TurnCompletionController {
      return createTurnCompletionController(this, callbacks);
  }

  private createToolExecutionController(): ToolExecutionController {
      return createToolExecutionController(this);
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

  recordModelRoutingShadow(currentSensorium: Sensorium, efe: EFEComponents): void {
    this.modelRoutingShadow.record(currentSensorium, efe)
  }

  bindSessionDomain(taskDescription: string): void {
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
  abortStalledTurn(): void {
    this._watchdogAborted = true
    this.abortController?.abort()
  }

  setApprovalMode(mode: ApprovalMode): void {
    this.config.approvalMode = mode
  }

  /** Attach a GoalTracker to the current run. Owned by AgentLoop; the
   *  orchestrator reads it via deps.getGoalTracker (no longer a field on
   *  TurnOrchestrator), severing the loop→orchestrator back-edge that
   *  getDoomLoopLevel/isGoalActive used to traverse. */
  setGoalTracker(tracker: import('./goal-tracker.js').GoalTracker | null): void {
    this.goalTracker = tracker
  }

  /** Expose the goal tracker for deps wiring (orchestrator reads via getter). */
  getGoalTracker(): import('./goal-tracker.js').GoalTracker | null {
    return this.goalTracker
  }

  /** Check if goal tracker is active (for doom-loop threshold selection). */
  isGoalActive(): boolean {
    return this.goalTracker?.isActive() ?? false
  }

  /**
   * Single source of truth for the abort reason passed to onAbort(). Encodes
   * whether the current abort was a watchdog hard-stall (vs. a user Ctrl+C) and,
   * for watchdog stalls during a goal run, tags `watchdog:goal` so the UI can
   * auto-recover/continue instead of treating it as a user interrupt. Used by
   * every onAbort emission site (turn-orchestrator deps + turn-step-producer)
   * so the encoding stays consistent across abort paths.
   */
  abortReason(): string | undefined {
    if (!this._watchdogAborted) return undefined
    return this.isGoalActive() ? 'watchdog:goal' : 'watchdog'
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

  /**
   * 应用工具门控后的定义集 — 构造期之外（MCP/LSP 注册刷新、逃生口挂载）的唯一过滤入口。
   * 复用 createAgentConfig 同款 gateToolDefinitions，确保 updateTools 不会把 EXTENDED 工具
   * 整个还原（历史 bug：MCP/LSP 初始化后 updateTools 拉全量 → 门控被毫秒内覆盖）。
   */
  private gatedToolDefinitions(): import('../api/types.js').ToolDefinition[] {
    const all = this.config.toolRegistry.getDefinitions()
    const gating = this.config.toolGating
    if (!gating) return all
    return gateToolDefinitions(all, {
      enabled: gating.enabled,
      coreOverride: gating.coreOverride,
      extraCore: gating.extraCore,
      domainTier: gating.domainTier,
      mountedExtras: [...this.mountedExtras],
    })
  }

  updateTools(): void {
    this.config.promptEngine.updateTools(this.gatedToolDefinitions())
  }

  /** 当前主控实际可见的工具名（已应用门控 + 运行时挂载）。 */
  getActiveToolNames(): string[] {
    return this.gatedToolDefinitions().map(d => d.name)
  }

  /**
   * 逃生口：把一个 EXTENDED 工具临时挂回主控（在 turn 边界由 slash 命令触发）。
   *
   * 代价：挂载会改变 staticCtx.tools 的 fingerprint，对 exact-prefix 缓存的 provider
   * （deepseek-native / anthropic-cache-control）造成一次性全前缀缓存失效；'none' provider 无代价。
   *
   * @returns 结构化结果，供 UI 渲染（status + 缓存影响）
   */
  enableTool(name: string): {
    status: 'mounted' | 'already-active' | 'not-extended' | 'unknown' | 'gating-off'
    cacheImpact: 'prefix-invalidated' | 'none'
    prefixCacheStrategy: 'deepseek-native' | 'anthropic-cache-control' | 'none'
  } {
    const strategy = this.config.prefixCacheStrategy ?? 'none'
    const cacheImpact: 'prefix-invalidated' | 'none' =
      strategy === 'none' ? 'none' : 'prefix-invalidated'

    // 门控未开 → 全量本就可见，无需挂载
    if (!this.config.toolGating || !this.config.toolGating.enabled) {
      return { status: 'gating-off', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 工具必须真实注册
    if (!this.config.toolRegistry.getDefinitions().some(d => d.name === name)) {
      return { status: 'unknown', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 仅 EXTENDED 工具需要逃生口；非 EXTENDED（CORE/MCP/LSP）默认已可见
    if (!isExtendedTool(name)) {
      return { status: 'not-extended', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    // 已挂载 → 幂等
    if (this.mountedExtras.has(name)) {
      return { status: 'already-active', cacheImpact: 'none', prefixCacheStrategy: strategy }
    }
    this.mountedExtras.add(name)
    this.updateTools()
    return { status: 'mounted', cacheImpact, prefixCacheStrategy: strategy }
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

  /**
   * PlusMenu — per-session disabled skill names. Filters the skill discovery
   * block (turn-step-producer) so disabled skills are hidden from the model.
   * Empty set = all skills available (default).
   */
  private _disabledSkills: Set<string> = new Set()

  /** Replace the per-session disabled skill set (desktop skill toggle). */
  setDisabledSkills(names: Set<string>): void {
    this._disabledSkills = new Set(names)
  }

  /** Read the per-session disabled skill set (consumed by turn-step-producer). */
  getDisabledSkills(): Set<string> {
    return this._disabledSkills
  }

  getLatestPheromones() { return this.loadedPheromones }

  /** Expose MeridianIndexer for /index command */
  getIndexer() { return this.config.meridianIndexer ?? null }

  getDecisions(): string[] { return this.decisions }

  getContextLayerReport() { return this.config.promptEngine.getContextLayerReport() }

  getDoomLoopLevel(): 'none' | 'warn' | 'blocked' {
    // Goal-active mode uses relaxed thresholds to avoid false doom-loop triggers
    // during long autonomous tasks where repeated tool types are legitimate.
    const thresholds = getDoomLoopThresholds(this.goalTracker?.isActive() ?? false)
    return combineDoomLoopLevels(
      getDoomLoopLevel(this.traceStore.toolFingerprints, thresholds.exact),
      getClassDoomLoopLevel(this.traceStore.bashClassFingerprints ?? [], thresholds.class),
    )
  }

  getReliabilityDecision(): ReliabilityDecision | null { return this.latestReliabilityDecision }

  private sessionPersistPath(): string | undefined {
    return this.persist?.getFilePath()
  }

  refreshReliabilityDecision(): void {
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
    this.latestReliabilityDecision = modeForRecoveryTrigger(trigger, this.isGoalActive())
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

  /** Enter plan mode — only read-only tools allowed. Clears any stale approved-plan pointer. */
  enterPlanMode(): void {
    this.planModeState = 'planning'
    this.config.promptEngine.setActivePlan(null)
  }

  /** Exit plan mode — user approved, all tools allowed */
  exitPlanMode(): void { this.planModeState = 'off' }

  /**
   * Set (or clear) the approved-plan pointer. Injects a tiny slug/title/path
   * reminder into the dynamic appendix — NOT the plan body (which stays on disk).
   * Approving releases plan mode (state→off) so execution tools are unblocked.
   * Cache-safe: the pointer never enters the frozen base.
   */
  setActivePlan(plan: { slug: string; title: string } | null): void {
    if (!plan) {
      this.config.promptEngine.setActivePlan(null)
      return
    }
    this.config.promptEngine.setActivePlan(formatActivePlanPointer(plan))
    this.planModeState = 'off'
    this.syncPlanModeToConfig()
  }

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

  /** Estimated token count for the current conversation (live, for desktop ctx-bar). */
  getEstimatedTokens(): number {
    return this.session.getEstimatedTokens()
  }

  /** Real context-window occupancy (anchor on last API prompt_tokens + tail
   *  estimate) — for display only. See SessionContext.getRealOccupancy. */
  getRealOccupancy(): number {
    return this.session.getRealOccupancy()
  }

  /** Observe-only recall stats for compacted-history artifacts (for /context).
   *  Cheap delegate — avoids the heavier getDebugInfo() build. */
  getRecallSummary(): RecallMetricsSummary {
    return this.cacheAdvisor.getRecallSummary()
  }

  /** Model context window size in tokens. */
  getContextWindow(): number {
    return this.config.contextWindow
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
    // Sink compact-history recall stats into the (gated) sensorium channel.
    // Observe-only: collects turn-distance data for a future adaptive-window
    // decision; it does NOT influence compaction thresholds today.
    try {
      this.telemetryWriter.write({ kind: 'recall-summary', ...this.cacheAdvisor.getRecallSummary() })
    } catch { /* telemetry is best-effort */ }
  }

  async startFsWatcher(): Promise<void> {
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

  isRunning(): boolean {
    return this._running
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
    this._watchdogAborted = false
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
    // Cross-session learning load: config.crossSessionEnabled (default true) activates it.
    // Env RIVET_NO_CROSS_SESSION=1 overrides as force-off.
    if (!this.config.crossSessionEnabled) return
    if (process.env.RIVET_NO_CROSS_SESSION === '1' || process.env.RIVET_NO_CROSS_SESSION === 'true') return
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
      providerName: this.config.providerName,
      outputTokens: this.session.getTotalUsage().output_tokens,
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
      this.advisoryBus.submit({
        key: 'convergence',
        priority: 0.65,
        tier: 'operational',
        category: 'discipline',
        content: convergenceCheck.injectedMessage,
      })

      // When convergence is detected AND doom loop is blocked, the agent is
      // likely in a post-completion verification loop. Append gate hint
      // to the same SR (already injected above) instead of creating a second SR.
      if (this.getDoomLoopLevel() === 'blocked' && convergenceCheck.level >= 2) {
        let gateHint = '任务验证循环已检测到。如果交付门禁为 GREEN，请输出最终摘要并结束回合。不再调用工具。'
        try {
          const gate = this.config.deliveryGateV2?.([...this.evidence.getState().filesModified])
          if (gate) gateHint = `任务验证循环已检测到。${buildGateConvergenceHint(gate, this._taskDepthLayer)}`
        } catch { /* gate evaluation must never break convergence handling */ }
        this.advisoryBus.submit({
          key: 'convergence-gate',
          priority: 0.6,
          tier: 'operational',
          category: 'discipline',
          content: gateHint,
        })
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

  private async _runInner(userInput: string, callbacks: AgentCallbacks, images?: string[]): Promise<void> {
    await this.turnOrchestrator.execute(userInput, callbacks, images)
  }

}

