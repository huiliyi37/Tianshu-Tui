import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { OaiChatRequest, OaiMessage } from '../api/oai-types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { getGitInjectedContext } from '../prompt/volatile-git.js'
import { ToolRegistry } from '../tools/registry.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm, buildPrewarmValue, buildPrewarmValueAsync } from './prewarm-file.js'
import { validatePathSafe } from '../tools/path-validate.js'
import { type CompactionConfig, staleRoundThresholds } from '../compact/constants.js'
import type { CompactCircuitBreakerState, ContextAnchor } from '../context/types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import { EvidenceTracker } from './evidence.js'
import { TurnHarness } from './turn-harness.js'
import { TrajectoryRecorder } from './trajectory.js'
import type { HookRegistry } from '../hooks/registry.js'
import { createTraceStore, type TraceStore } from './trace-store.js'
import { getDoomLoopLevel } from './trace-store.js'
import { evaluateConvergence } from './convergence-detector.js'
import type { PhaseClass } from './convergence-detector.js'
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
import { getErrorRate } from './prediction-error.js'
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
import { createAnchorGraph } from '../prompt/anchor-graph.js'
import { createHash } from 'node:crypto'
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
import { buildModelRoutingShadowEvent, inferLegacyRoutingRecommendation, persistModelRoutingShadow } from './model-routing-shadow.js'
import { buildModelPolicyCandidates, selectModelPolicy } from './model-policy-selection.js'
import { buildHistoricalModelRewards } from './model-reward-summary.js'
import { recordRoutingRewardClosure } from './reward-loop.js'
import { renderPlanCacheAdvisory } from './plan-cache-advisory.js'
import { createTelemetryWriter } from './telemetry-writer.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import { PressureMonitor } from '../context/pressure-monitor.js'
import { createFsWatcher } from '../context/fs-watcher.js'
import type { FsWatcherState } from '../context/fs-watcher.js'
import { buildCognitivePromptProjection, createCognitiveLedger, getCognitivePhaseSnapshot, type CognitivePhaseSnapshot } from '../context/cognitive-ledger.js'
import { compactStaleRoundsOai } from '../compact/stale-round.js'
import { CacheAdvisor } from '../cache/advisor.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { TurnHeartbeat } from './turn-heartbeat.js'
import { rejectOnAbort } from './turn-boundary-abort.js'
import { createP3Integration, P3Integration } from './p3-integration.js'
import type { HealthSignal } from './trajectory-health.js'
import { ImmuneHook } from './immune-hook.js'
import { formatImmuneContext } from './immune-context.js'
import { checkTddGate } from './tdd-gate.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
import { getPhysarumShadowStatsFromDb } from '../repo/physarum-shadow-stats.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'
import { createTurnBudget, type TurnBudget } from './turn-budget.js'
import { classifyRecoveryTrigger } from './recovery-trigger.js'
import { modeForRecoveryTrigger, type ReliabilityDecision } from './reliability-mode.js'
import { ResourceSensor, type ResourceSensorOptions, type ResourceSensorSnapshot } from './resource-sensor.js'
import { advanceContractStatus, contractStatusFromPhaseClass, extractTaskContract, isActionableTurn, type TaskContract } from '../context/task-contract.js'
import { StigmergyStore } from '../context/stigmergy.js'
import { createStanceTally } from './stance-tally.js'
import type { Pheromone, PheromoneQueryResult } from '../context/stigmergy.js'
import { ProviderHealthTracker } from './provider-health.js'
import type { PrefixFingerprint } from '../prompt/fingerprint.js'
import type { IntentPreview, IntentPreviewAction } from './intent-preview.js'
import type { PlaybookStore } from './playbook-store.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import { normalizeAntiAnchoringConfig } from './anti-anchoring-config.js'
import { classifyIntentRetrievalRoute } from './intent-retrieval-router.js'
import { renderIntentRetrievalRoute } from './intent-retrieval-route.js'
import type { SensoriumEntry } from './retrospect.js'
import { join } from 'node:path'
import { formatEventsForAppendix } from './hooks/cross-session-hook.js'
import type { ApprovalMode, AgentConfig, AgentCallbacks } from './loop-types.js'
import { recordToolHistory } from "./tool-history-recorder.js";
import { requestThetaCheck } from "./theta-controller.js";
import { createTurnStreamController, createTurnCompletionController, createToolExecutionController, buildRuntimeSnapshot } from "./loop-factory.js";
import { buildEffortContext, type EffortShadowRecord } from './p3-reward.js'
import { resolveEffortDelta } from './effort-delta.js'

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

export class AgentLoop {
    session!: SessionContext;
    config!: AgentConfig;
  abortController: AbortController | null = null
  /** Count of user interrupts within the current turn (中#5). */
  private _turnInterruptCount = 0
  cwd: string
  evidence: EvidenceTracker
  private compactFailures: CompactCircuitBreakerState = { consecutiveFailures: 0 }
  recentToolHistory: ToolHistoryEntry[] = []
  prewarm = new PrewarmCache(60_000, 50)
  private _running = false
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
  streamedText = ''
  private thinkingOnlyRetries = 0
  private lastThinkingContent = ''
  private consecutiveNoToolTurns = 0
  private lastTurnTextFingerprint = ''
  private lastTurnThinkingFingerprint = ''
  lastPrewarmAt = 0
  private lastCacheDiagnostic: string | null = null
  private latestRisk: import('./approval-risk.js').RiskAssessment = { level: 'none', reasons: [], suggestedAction: 'No additional approval required.' }
  private planModeState: PlanModeState = 'off'
  decisions: string[] = []
  trajectory = new TrajectoryRecorder()
  repairPipeline = new RepairPipeline([ctclSanitizerPass, fourHorsemenPass, semanticRepairPass])
  repairHintTracker = new RepairHintTracker()
  traceStore: TraceStore
  harness: TurnHarness
  routingMetrics = new RoutingMetricsCollector()
  private importGraph: ImportGraph | null = null
  private lastConflictCheckCount = 0
  predictionAccumulator: PredictionAccumulator = createPredictionAccumulator()
  private sessionDomain: ActiveStarDomain | null | undefined
  /** Session-local affordance adaptations — per-session, never mutates global registry */
  private sessionAffordanceAdaptations: Record<string, import('./affordance.js').BaseAffordance> = {}
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  private prevAnchorGraphHash: string | null = null
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
  private compaction: CompactionController
  private turnStream: TurnStreamController | null = null
  private turnCompletion: TurnCompletionController
  private toolExecution: ToolExecutionController
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
  private telemetryWriter: TelemetryWriter
  private baselineFingerprint: PrefixFingerprint | null = null
  private sensoriumSnapshots: SensoriumEntry[] = []
  private taskContract?: TaskContract
  private latestCognitiveSnapshot?: CognitivePhaseSnapshot
  private persist: SessionPersist | null = null
  private resourceSensor: ResourceSensor
  private latestResourceSnapshot: ResourceSensorSnapshot | null = null
  latestReliabilityDecision: ReliabilityDecision | null = null
  private fsWatcher: ReturnType<typeof createFsWatcher> | null = null
  private latestFsWatcherState: FsWatcherState = { eventRate: 0, eventCount: 0, active: false }
  currentSeason: CognitiveSeason | null = null
  private lastCompactTurn: number | null = null
  cacheAdvisor: CacheAdvisor
  p3: P3Integration
  immuneHook: ImmuneHook
  _lastImmuneHint?: import('./immune-context.js').ImmuneContextHint
  lastToolCompleteTime = 0
  private initialUserMessage: string | null = null
  /** Sliding window of recent turn text fingerprints for cross-turn repetition detection. */
  private recentTextFingerprints: string[] = []
  /** T2-02: Current effort shadow record (telemetry only in P0, influences effort in P3+) */
  private _currentEffortShadow: EffortShadowRecord | null = null

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

    this.runtimeHooks = this.config.runtimeHooks ?? new RuntimeHookPipeline(createDefaultRuntimeHooks({
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
      callAntiAnchoringSeedModel: prompt => this.callAntiAnchoringSeedModel(prompt),
      songlineEnabled: this.config.songlineEnabled,
      getTaskSummary: this.config.taskLedger ? () => this.config.taskLedger!.getSummary() : undefined,
      setCycleClose: this.config.sessionRegistry
        ? (sessionId, closeHash) => this.config.sessionRegistry!.setCycleClose(sessionId, closeHash)
        : undefined,
      // ── HEARTH observe (pure diagnostic) ──
      hearthObserveEnabled: this.config.hearthObserveEnabled,
      getAnchorGraph: () => this.buildAnchorGraph(),
      getPrevAnchorGraphHash: () => this.prevAnchorGraphHash,
      setPrevAnchorGraphHash: (hash: string) => { this.prevAnchorGraphHash = hash },
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
      getCwd: () => this.cwd,
    })
    this.compaction = new CompactionController({
      session: this.session,
      promptEngine: this.config.promptEngine,
      contextWindow: this.config.contextWindow,
      providerProfile: this.config.providerProfile,
      primaryClient: this.config.primaryClient,
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
    })
    this.turnStream = this.createTurnStreamController()
    this.turnCompletion = this.createTurnCompletionController()
    this.toolExecution = this.createToolExecutionController()
    
    // 初始化 SessionPersist 用于 fuzzy checkpoint
    if (this.config.sessionId) {
      this.persist = new SessionPersist(this.config.sessionId)

      // P1: Initialize session metadata with model info
      this.persist.initMetadata({
        model: this.config.promptEngine.getModel(),
      })

      // P0-1: Mirror every in-memory message change to disk so non-/exit
      // shutdowns (Ctrl+C, crash, network drop) don't lose the session.
      // - append: serialize via a single promise chain to keep file order
      //   stable even when consecutive tool_results fire fast.
      // - replace: full atomic rewrite via compactOai (compaction/reset).
      const persist = this.persist
      let writeChain: Promise<void> = Promise.resolve()
      this.session.setMutationListener((m) => {
        if (m.type === 'append') {
          const msg = m.message
          writeChain = writeChain
            .then(() => persist.appendOaiWithChecksum(msg))
            .then(() => {
              // P0-1 trace: verify every message triggers persistence
              debugLog(`[persist] append message role=${msg.role}`)
              // P1: Update metadata on every append. Snapshot once instead of
              // re-reading .meta.json per field — this runs on the hot append
              // path (N tool calls = N appends per turn).
              try {
                const snapshot = persist.loadMetadata()
                const patch: Partial<import('../context/types.js').SessionMetadata> = {}
                // TTSR injects guardrail reminders as <system-reminder>-wrapped
                // role:user messages; they are not real user turns (history-replay
                // also excludes them), so don't title/count them.
                const isReminder = typeof msg.content === 'string' && msg.content.startsWith('<system-reminder>')
                if (msg.role === 'user' && !isReminder) {
                  if (typeof msg.content === 'string' && !snapshot?.title) {
                    patch.title = msg.content.slice(0, 120)
                  }
                  patch.turnCount = (snapshot?.turnCount ?? 0) + 1
                }
                if (msg.role === 'assistant' && msg.tool_calls) {
                  patch.toolCallCount = (snapshot?.toolCallCount ?? 0) + msg.tool_calls.length
                }
                const usage = this.session.getTotalUsage()
                patch.tokenUsage = {
                  prompt: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens,
                  completion: usage.output_tokens,
                  total: usage.input_tokens + usage.cache_read_input_tokens + usage.cache_creation_input_tokens + usage.output_tokens,
                }
                persist.updateMetadata(patch)
              } catch { /* metadata update failures are non-critical */ }
            })
            .catch(err => {
              // Persistence failures must not crash the agent loop.
              // Surface to stderr; the in-memory state is still authoritative.
              // eslint-disable-next-line no-console
              console.error('[session-persist] append failed:', err)
            })
        } else {
          // replace is rare (compaction/reset); do it asynchronously after the
          // current append queue drains so the rewrite reflects the latest state.
          writeChain = writeChain
            .then(() => persist.compactOaiAsync(m.messages))
            .catch(err => {
              // eslint-disable-next-line no-console
              console.error('[session-persist] compact failed:', err)
            })
        }
      })
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
  buildRuntimeSnapshot(extra?: Partial<RuntimeHookSnapshot>): RuntimeHookSnapshot {
      return buildRuntimeSnapshot(this, extra);
  }


  recordToolHistory(name: string, input: Record<string, unknown>, isError: boolean, result: string): void {
      recordToolHistory(this, name, input, isError, result);
  }

  private recordModelRoutingShadow(currentSensorium: Sensorium, efe: EFEComponents): void {
    if (this.config.modelRoutingShadowEnabled === false) return
    const store = this.config.meridianIndexer?.getDb()
    if (!store) return

    try {
      const recentCalls = this.trajectory.getEntries().slice(-10).map(entry => ({
        name: entry.tool,
        isError: entry.status === 'failed' || entry.status === 'retried-failed',
      }))
      const modelCards = this.config.modelRoutingShadowModelCards ?? this.config.modelCards
      const legacyRouting = inferLegacyRoutingRecommendation(recentCalls, modelCards)
      const historicalRewards = buildHistoricalModelRewards(store)
      const efeRecommendation = selectModelPolicy({
        candidates: buildModelPolicyCandidates(modelCards, { historicalRewards }),
        efe,
        sensorium: currentSensorium,
        topK: 1,
      })[0]
      const event = buildModelRoutingShadowEvent({
        sessionId: this.config.sessionId ?? 'unknown',
        turn: this.session.getTurnCount(),
        objective: this.initialUserMessage ?? '',
        currentModel: this.config.getCurrentModel?.() ?? this.config.promptEngine.getModel(),
        selectedBy: this.config.getCurrentModel ? 'human' : 'config',
        legacyRouting,
        ...(efeRecommendation ? { efeRecommendedModel: efeRecommendation.model } : {}),
        sensorium: currentSensorium,
      })
      persistModelRoutingShadow(store, event)
      recordRoutingRewardClosure(store, event)
    } catch {
      // Shadow telemetry must never affect the turn.
    }
  }

  private bindSessionDomain(taskDescription: string): void {
    if (this.sessionDomain !== undefined) return
    this.sessionDomain = isStarSoulEnabled() ? buildActiveDomain(taskDescription) : null
    this.config.promptEngine.setActiveDomain(this.sessionDomain)
  }

  /**
   * Build the HEARTH anchor graph from current runtime state.
   *
   * - pole_structure = hash of system + tools fingerprint
   * - pole_void = XOR complement of pole_structure
   * - cycle_close = last session's cycle_close (or empty if first)
   * - cycle_open = current session's sessionId (deterministic seed)
   * - center_belief = hash of system prompt alone (founding covenant)
   */
  private buildAnchorGraph(): ReturnType<typeof createAnchorGraph> {
    const fp = this.config.promptEngine.getFingerprint()
    const structureHash = createHash('sha256')
      .update(`${fp.systemSha256}:${fp.toolsSha256}`)
      .digest('hex')
    const voidShape = hexComplement(structureHash)

    const prevCycleClose =
      this.config.sessionRegistry?.getLastCycleClose() ?? ''

    const currentCycleOpen = createHash('sha256')
      .update(`cycle-open:${this.config.sessionId ?? 'unknown'}`)
      .digest('hex')

    const centerBeliefHash = fp.systemSha256

    return createAnchorGraph({
      structureHash,
      voidShape,
      prevCycleClose,
      currentCycleOpen,
      centerBeliefHash,
    })
  }

  private async callAntiAnchoringSeedModel(prompt: string): Promise<string> {
    const antiAnchoring = normalizeAntiAnchoringConfig(this.config.antiAnchoring)
    const request: OaiChatRequest = {
      model: this.config.promptEngine.getModel(),
      messages: [{ role: 'user', content: prompt }],
      max_tokens: antiAnchoring.seedMaxTokens,
      stream: true,
      temperature: 0.9,
      tool_choice: 'none',
    }
    let text = ''
    await this.config.client.stream(request, {
      onTextDelta: delta => { text += delta },
      onThinkingDelta: () => {},
      onContentBlock: block => {
        if (block.type === 'text') text += block.text
      },
      onStopReason: () => {},
      onError: error => { throw error },
    }, this.abortController?.signal)
    return text.trim()
  }

  private getLastAssistantMessageContent(messages: OaiMessage[]): string | null {
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i]
      if (msg?.role === 'assistant' && typeof msg.content === 'string') {
        return msg.content
      }
    }
    return null
  }

  private async buildIntentRetrievalRouteForTurn(userInput: string, actionable: boolean): Promise<void> {
    if (!actionable || !this.taskContract) {
      this.config.promptEngine.setIntentRetrievalRoute(null)
      return
    }

    try {
      const messages = this.session.getMessages()
      const lastAssistant = this.getLastAssistantMessageContent(messages) || undefined
      // 从上一轮 Assistant 回复中持久化提取任务列表，支持跨多轮回溯
      if (lastAssistant && this.sessionStateManager) {
        this.sessionStateManager.extractTaskList(lastAssistant, this.session.getTurnCount())
      }
      // 用户引用某个任务编号（如"做 P1"）时，将其标记为 in_progress —
      // 让持久化状态机活起来，TUI 任务条得以反映进度而非永远 pending。
      if (this.sessionStateManager) {
        const referenced = userInput.match(/\b([PpTtSs]\d+)\b/g)
        if (referenced) {
          const turn = this.session.getTurnCount()
          for (const ref of new Set(referenced.map(r => r.toUpperCase()))) {
            this.sessionStateManager.updateTaskListItem(ref, 'in_progress', turn)
          }
        }
      }
      const route = await classifyIntentRetrievalRoute({
        userMessage: userInput,
        lastAssistantMessage: lastAssistant,
        taskList: this.sessionStateManager?.getTaskList(),
        taskContract: this.taskContract,
        config: this.config.intentRetrievalRouter,
        client: this.config.client,
        model: this.config.promptEngine.getModel(),
        signal: this.abortController?.signal,
        onTelemetry: telemetry => {
          debugLog(`[intent-router] classifier=${telemetry.classifier} fallback=${telemetry.fallbackUsed} kinds=${telemetry.taskKinds.join(',')} sources=${telemetry.sources.join(',')} directions=${telemetry.directionCount} latencyMs=${telemetry.latencyMs}`)
        },
      })
      this.config.promptEngine.setIntentRetrievalRoute(route ? renderIntentRetrievalRoute(route) : null)
    } catch (err) {
      debugLog(`[intent-router] failed: ${(err as Error).message}`)
      this.config.promptEngine.setIntentRetrievalRoute(null)
    }
  }

  async maybePrewarm(text: string): Promise<void> {
    const intents = extractIntents(text)
    for (const intent of intents) {
      if (intent.type !== 'file') continue
      const value = await buildPrewarmValue(this.cwd, intent.value)
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
    this._turnInterruptCount++
    this.abortController?.abort()
    // NOTE: killAll() removed — it was a global hammer that killed processes
    // from ALL AgentLoop instances, not just this one (中间层 #1).
    // abortController.abort() + reader.cancel() handles in-flight operations.
    // Process cleanup at exit is still handled by main.tsx's killAllSync().
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
  private syncPlanModeToConfig(): void {
    this.config.planModeState = this.planModeState
    this.config.promptEngine.setPlanModeState(this.planModeState)
  }

  setReasoningEffort(effort: import('./auto-reasoning.js').ReasoningEffort): void {
    const floor = this.config.reasoningFloor
    const rank: Record<string, number> = { off: 0, low: 1, medium: 2, high: 3, max: 4 }
    const effective = (floor && (rank[effort] ?? 2) < (rank[floor] ?? 0)) ? floor : effort
    // T2-02 Track A2: apply bandit delta (no-op when flag off or gate closed)
    const banditAdjusted = this.applyEffortDelta(effective) as import('./auto-reasoning.js').ReasoningEffort
    this.config.reasoningEffort = banditAdjusted
    this.config.client.setReasoningEffort?.(banditAdjusted)
  }

  /**
   * T2-02 P0: Shadow telemetry for effort bandit.
   * Records recommendation without changing behavior.
   * Called at effort decision points (initial selection + intervention adjustments).
   *
   * @param ruleBaseline The effort the rule-based heuristic selected (e.g., 'medium')
   * @param overrides Partial context overrides from the caller
   */
  shadowEffortTelemetry(
    ruleBaseline: string,
    overrides?: { errorRate?: number; isRepeat?: boolean },
  ): void {
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.taskContract ? 0.5 : 0.3,
        errorRate: overrides?.errorRate ?? getErrorRate(this.predictionAccumulator),
        turnDepth: this.session.getTurnCount() / Math.max(this.config.maxTurns ?? 50, 1),
        fileCount: this.evidence.getState().filesModified.size,
        isRepeat: overrides?.isRepeat ?? false,
        timeOfDay: new Date().getHours() / 24,
      })
      const record = this.p3.shadowRecommendEffort(ctx, ruleBaseline)
      if (record) {
        this._currentEffortShadow = record
      }
    } catch {
      // Shadow telemetry must never affect behavior
    }
  }

  /**
   * T2-02 P3: Get bandit-recommended effort delta if confidence threshold is met.
   * Returns null if bandit declines or insufficient data.
   */
  /**
   * T2-02 P3: Get bandit-recommended effort delta.
   *
   * Returns null in three cases:
   * 1. Feature flag effortBanditEnabled is false (zero behavior change).
   * 2. Consistency gate not open (totalPulls < 30 or agreement rate < 0.8).
   * 3. Bandit itself declines the recommendation.
   *
   * Only when all three pass does the bandit get a vote.
   */
  getEffortDelta(): number | null {
    if (!this.config.effortBanditEnabled) return null
    if (!this.p3.isEffortGateOpen()) return null
    try {
      const ctx = buildEffortContext({
        taskComplexity: this.taskContract ? 0.5 : 0.3,
        errorRate: getErrorRate(this.predictionAccumulator),
        turnDepth: this.session.getTurnCount() / Math.max(this.config.maxTurns ?? 50, 1),
        fileCount: this.evidence.getState().filesModified.size,
        isRepeat: false,
        timeOfDay: new Date().getHours() / 24,
      })
      const rec = this.p3.recommendEffortDelta(ctx)
      return rec?.delta ?? null
    } catch {
      return null
    }
  }

  getReasoningEffort(): import('./auto-reasoning.js').ReasoningEffort | undefined {
    return this.config.reasoningEffort
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

  getRoutingReason() { return this.config.promptEngine.getRoutingReason() }

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
      requestThetaCheck(this, reason);
  }

  getLatestRisk(): import('./approval-risk.js').RiskAssessment { return this.latestRisk }

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
    // Cleanup old cross-session events (2h TTL)
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }

    // Persist Physarum edge state to MeridianDb
    try { this.immuneHook.getPhysarum().save() } catch { /* non-critical */ }

    // Persist immune memories for cross-session secondary response
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveImmuneMemories(this.immuneHook.exportMemories())
    } catch { /* non-critical */ }

    // Persist mistake notebook for cross-session learning
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveMistakeEntries(this.p3.notebook.getAllEntries())
    } catch { /* non-critical */ }

    // Persist P3 tool transition miner for cross-session speculation.
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) db.saveToolPatternMinerSnapshot(this.p3.miner.exportSnapshot())
    } catch { /* non-critical */ }

    // T2-02 P1: Persist bandit states to MeridianDb
    try {
      const db = this.config.meridianIndexer?.getDb()
      if (db) {
        db.saveBanditState('bandit:reasoning_effort', this.p3.serializeEffortBandit())
        db.saveBanditState('bandit:model_style', this.p3.serializeBandit())
        // Track B1: Persist PlanCache
        db.saveBanditState('p3:plan_cache', this.p3.serializePlanCache())
      }
    } catch { /* non-critical */ }
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
    // Re-entry guard: prevent concurrent agent.run() calls.
    // React strict mode or rapid re-submits could trigger handleSubmit
    // while a previous run is still in-flight, corrupting SessionContext.
    if (this._running) {
      debugLog('[agent] run() called while already running — skipping duplicate')
      return
    }
    this._running = true
    try {
      await this._runInner(userInput, callbacks)
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
    this.physarumForWarmup?.loadFromDb()
    const physarumLoadStats = this.physarumForWarmup?.getLastLoadStats()
    if (physarumLoadStats && physarumLoadStats.discarded > 0) {
      this.physarumForWarmup?.cleanupPersistedEdges()
      debugLog(`[physarum] filtered ${physarumLoadStats.discarded} polluted persisted edges; loaded=${physarumLoadStats.loaded}; samples=${JSON.stringify(physarumLoadStats.discardedSamples)}`)
    }
    try { this.immuneHook.importMemories(db.loadImmuneMemories()) } catch { /* non-critical */ }
    try { this.p3?.notebook.importEntries(db.loadMistakeEntries()) } catch { /* non-critical */ }
    try {
      const snapshot = db.loadToolPatternMinerSnapshot()
      if (snapshot) this.p3.miner.importSnapshot(snapshot)
    } catch { /* non-critical */ }
    // T2-02 P1: Restore bandit states from MeridianDb (cross-session learning).
    // effortBandit / bandit are readonly on P3Integration, so we restore them
    // in place via importState rather than reassigning the references.
    try {
      const effortBanditJson = db.loadBanditState('bandit:reasoning_effort')
      if (effortBanditJson) this.p3.effortBandit.importState(effortBanditJson)
      const modelBanditJson = db.loadBanditState('bandit:model_style')
      if (modelBanditJson) this.p3.bandit.importState(modelBanditJson)
    } catch { /* non-critical */ }
    // Track B1: Restore PlanCache from MeridianDb
    try {
      const planCacheJson = db.loadBanditState('p3:plan_cache')
      if (planCacheJson) this.p3.importPlanCache(planCacheJson)
    } catch { /* non-critical */ }
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
    try {
      const delta = this.getEffortDelta()
      return resolveEffortDelta(baseEffort, delta, this.config.reasoningFloor)
    } catch {
      return baseEffort
    }
  }

  /**
   * Step 6a: Per-run initialization — warmup, heartbeat, state resets,
   * worktree detection, session split, user message, task contract.
   *
   * Returns the heartbeat (for cleanup) and the wrapped callbacks (which
   * the caller must use for the rest of the run).
   */
  private async initializeRun(userInput: string, callbacks: AgentCallbacks): Promise<{ heartbeat: TurnHeartbeat, wrappedCallbacks: AgentCallbacks, actionable: boolean }> {
    await this.warmupMemories()
    this.abortController = new AbortController()
    this._turnInterruptCount = 0
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
    callbacks = this.wrapCallbacksWithHeartbeat(callbacks, heartbeat)
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

    // Phase 2.3: Proactive session split at 86% context — MUST run BEFORE
    // addUserMessage, otherwise the split replaces the just-added user message
    // and the model never sees the new user input.
    await this.compaction.trySessionSplit()

    this.session.addUserMessage(userInput)
    const actionable = isActionableTurn(userInput)
    this.config.promptEngine.setActionableTurn(actionable)

    if (actionable) {
      // Explicit actionable message → extract fresh contract (may supersede old)
      this.taskContract = extractTaskContract(userInput, this.session.getTurnCount())
    } else if (!this.taskContract || this.taskContract.status === 'ready_to_deliver') {
      // No active contract to inherit, or previous task already delivered → skip
      this.taskContract = undefined
    }
    // else: non-actionable follow-up to active task → inherit existing contract

    await this.buildIntentRetrievalRouteForTurn(userInput, actionable)
    this.config.promptEngine.setPlanCacheAdvisory(
      actionable ? renderPlanCacheAdvisory(this.p3.planCacheSuggest(userInput)) : null,
    )

    if (this.config.autoReasoning && actionable) {
      const ruleEffort = selectReasoningEffort(userInput, this.config.reasoningFloor)
      // T2-02 Track A2: apply bandit delta (no-op when flag off or gate closed)
      const banditAdjusted = this.applyEffortDelta(ruleEffort) as import('./auto-reasoning.js').ReasoningEffort
      this.config.reasoningEffort = banditAdjusted
      this.config.client.setReasoningEffort?.(banditAdjusted)
      // T2-02 P0: shadow telemetry — record bandit recommendation without changing effort
      this.shadowEffortTelemetry(ruleEffort)
    }
    return { heartbeat, wrappedCallbacks: callbacks, actionable }
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
  private async buildTurnRequest(
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
        appendix = (appendix ? appendix + '\n' : '') +
          `<cross-session-claims count="${claims.length}">\n${claimLines.join('\n')}\n</cross-session-claims>`
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

  private runCognitivePrep(
    turn: number,
    actionable: boolean,
    pressureResult: import('../context/pressure-monitor.js').PressureResult,
  ): void {
    // ── Sycophancy Trap: record previous turn agreement ──
    // 仁者必有勇。连续盲从 + confidence 下降 → 质疑注入。
    // agreedWithUser: 有破坏性操作，但既没有质疑（ask_user_question），
    // 也没有验证（read_file, grep, typecheck 等）→ 盲从执行。
    // 先质疑再执行 → 独立判断；先验证再执行 → 尽责执行。
    const recentToolNames = this.recentToolHistory.slice(-8).map(h => h.tool)
    const hadAskTool = recentToolNames.includes('ask_user_question')
    const verificationTools = new Set([
      'read_file', 'grep', 'glob', 'run_tests',
      'lsp_goto_definition', 'lsp_find_references', 'inspect_project',
    ])
    const hadVerification = recentToolNames.some(t => verificationTools.has(t))
    const hadDestructive = recentToolNames.some(
      t => t === 'write_file' || t === 'edit_file' || t === 'bash'
    )
    // Blind execution: destructive without question AND without verification
    const agreedWithUser = hadDestructive && !hadAskTool && !hadVerification
    if (actionable && (hadDestructive || hadAskTool)) {
      this.sycophancyTrap.recordTurn({
        agreedWithUser,
        confidence: this.sensorium?.confidence ?? 0.5,
      })
    }

    // Immune signal: surface new sycophancy detection as danger signal (rising edge only)
    const sycActive = this.sycophancyTrap.shouldInjectChallenge()
    if (sycActive && !this.sycophancyWasActive) {
      try {
        this.immuneHook.injectSignal({
          kind: 'sycophancy_detected',
          severity: 0.7,
          turn,
          source: 'sycophancy-trap',
        })
      } catch { /* non-critical */ }
    }
    this.sycophancyWasActive = sycActive

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

  private async runConvergenceCheck(
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
    debugLog(`[convergence] turn=${turn} score=${convergenceCheck.score.toFixed(2)} level=${convergenceCheck.level} phase=${phaseClass}`)

    if (convergenceCheck.shouldKick && convergenceCheck.injectedMessage) {
      // Level 2: inject user guidance as a system-visible nudge
      callbacks.onPhaseChange?.('convergence-warning', {
        reason: `收敛检测 L${convergenceCheck.level}: ${phaseClass} 阶段 ${turn} 轮未收敛 (score=${convergenceCheck.score.toFixed(2)})`,
        suggestion: convergenceCheck.injectedMessage.slice(0, 200),
      })
      this.session.addUserMessage(convergenceCheck.injectedMessage)

      // When convergence is detected AND doom loop is blocked, the agent is
      // likely in a post-completion verification loop. Signal completion
      // instead of letting the model continue alternating between tools.
      if (this.getDoomLoopLevel() === 'blocked' && convergenceCheck.level >= 2) {
        this.session.addUserMessage(
          '任务验证循环已检测到。如果交付门禁为 GREEN，请输出最终摘要并结束回合。不再调用工具。'
        )
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

  private async runPerception(
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
    }
    this.config.promptEngine.setAffordanceHint(renderAffordanceHint(affordanceState) || null)

    // ── Free Energy Engine: EFE-driven policy guidance ──
    const efe = computeEFE(this.predictionAccumulator, this.currentSeason, this.vigorState, currentSensorium)
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

    return { sensorium: perceptionResult.sensorium, strategy: perceptionResult.strategy, phaseClass, pressureResult }
  }

  private async runCompaction(
    turn: number,
    snap: ResourceSensorSnapshot | null,
  ): Promise<{
    compacted: boolean
    shouldAbort: boolean
    userMessageConsumed: boolean
  }> {
    let userMessageConsumed = false

    // Phase 2.3: Proactive session split at 86% context.
    let _tb = Date.now()
    if (await this.compaction.trySessionSplit()) {
      userMessageConsumed = true
    }
    debugLog(`[turn-boundary] turn=${turn} trySessionSplit: ${Date.now() - _tb}ms`)
    // A2: user may have aborted during trySessionSplit (which can trigger
    // 60s LLM compact). Bail early instead of continuing into maybeCompact.
    if (this.abortController!.signal.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }

    _tb = Date.now()
    const compactResult = await this.compaction.maybeCompact({
      loopTurn: turn,
      failures: this.compactFailures,
    })
    debugLog(`[turn-boundary] turn=${turn} maybeCompact: ${Date.now() - _tb}ms compacted=${compactResult.compacted}`)
    if (compactResult.compacted) userMessageConsumed = true
    // A2: bail after maybeCompact (can also trigger LLM compact on 1M windows)
    if (this.abortController!.signal.aborted) {
      return { compacted: false, shouldAbort: true, userMessageConsumed }
    }
    this.compactFailures = compactResult.failures
    // Immune signal: surface compaction failures as danger signal for dual-signal gating
    if (this.compactFailures.consecutiveFailures > 0) {
      try {
        this.immuneHook.injectSignal({
          kind: 'compaction_fail',
          severity: Math.min(1.0, this.compactFailures.consecutiveFailures * 0.3),
          turn,
          source: 'compaction-controller',
        })
      } catch { /* non-critical */ }
    }
    if (compactResult.compacted) {
      this.lastCompactTurn = turn
      // Hint V8 to release freed message objects sooner
      if (typeof globalThis.gc === 'function') globalThis.gc()
    }

    // Stale round compaction: proactively shrink N-2+ tool_results
    if (!compactResult.compacted) {
      // Token gate: skip stale-round + diet when under 50% context capacity
      const contextWindow = this.config.contextWindow ?? 1_000_000
      const tokenBudget = estimateOaiTokens(this.session.getMessages() as any)
      // P1+P2 trace: verify token gate skips diet/stale below 50% capacity
      // eslint-disable-next-line no-console
      const tokenRatio = tokenBudget / contextWindow
      const skipGate = tokenRatio < 0.5
      debugLog(`[token-gate] tokens=${tokenBudget} window=${contextWindow} ratio=${tokenRatio.toFixed(2)} skip=${skipGate}`)
      if (tokenRatio >= 0.5 && contextWindow < 1_000_000) {
        // P3-B AgentDiet: remove redundant/expired/useless trajectory segments first
        const dietBefore = this.session.getMessages()
        const dietResult = this.p3.dietMessages(dietBefore as any)
        if (dietResult.removedCount > 0) {
          this.session.replaceMessages(dietResult.messages as any)
        }

        const before = this.session.getMessages()
        // Take max of cacheAdvisor's adaptive value and the window-aware
        // default. cacheAdvisor is bounded to 600–2400 (legacy small-window
        // tuning); on a 1M window staleRoundThresholds gives 30K, which we
        // want to win unless cacheAdvisor has actually escalated.
        const advisorPreview = this.cacheAdvisor.getStalePreviewChars()
        const after = compactStaleRoundsOai(before, contextWindow, Math.max(advisorPreview, staleRoundThresholds(contextWindow).previewChars))
        if (after !== before) {
          this.session.replaceMessages(after)
          if (typeof globalThis.gc === 'function') globalThis.gc()
        }
      }
    }

    // Heap-driven forced compaction: when memory pressure is high,
    // run phase 1 only (tool content truncation).
    // On 1M+ windows, use a higher threshold (0.75) to delay prefix
    // cache disruption. Phase 2 (round removal) won't fire since
    // tokens << contextWindow — only tool_result truncation applies.
    const heapRatio = snap
      ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
      : 0
    const heapCompactThreshold = (this.config.contextWindow ?? 1_000_000) >= 1_000_000 ? 0.75 : 0.6
    if (!compactResult.compacted && heapRatio >= heapCompactThreshold && this.session.getMessages().length >= 10) {
      debugLog(`[memory-pressure] heap=${heapRatio.toFixed(2)} threshold=${heapCompactThreshold} msgCount=${this.session.getMessages().length}`)
      const before = this.session.getMessages()
      const contextWindow = this.config.contextWindow ?? 1_000_000
      const { messages: trimmed } = microCompactOai(before, contextWindow, this.session.getEstimatedTokens())
      if (trimmed.length < before.length || trimmed !== before) {
        this.session.replaceMessages(trimmed)
        if (typeof globalThis.gc === 'function') globalThis.gc()
      }
    }

    return { compacted: compactResult.compacted, shouldAbort: false, userMessageConsumed }
  }

  private async _runInner(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    const { heartbeat, wrappedCallbacks, actionable } = await this.initializeRun(userInput, callbacks)
    callbacks = wrappedCallbacks
    callbacks = wrappedCallbacks

    let checkpointCreatedThisTurn = false

    // Track whether any assistant response was produced this turn.
    // If the turn is aborted before any assistant output, we roll back
    // the user message so it doesn't pollute context on retry.
    let assistantResponded = false
    // Track whether compaction consumed the user message (session split /
    // LLM compact replace the message list). When true, skip removeLastMessage
    // because the user message no longer exists at the top of the stack.
    let userMessageConsumed = false

    // TTSR retry governor: cap how many times each stream rule may abort+retry
    // within a single run(). Without a cap, a model that keeps emitting a
    // matched command loops until maxTurns, spamming injected reminders. After
    // the cap, the rule is disabled for the rest of the run so the turn can
    // proceed.
    const ruleTriggerCounts = new Map<string, number>()
    const disabledRulePatterns = new Set<string>()
    const MAX_RULE_RETRIES = 2
    let lastInjectedReminder = ''

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        this.thetaRequestsThisTurn = 0
        // Sync plan-mode state into config so tool-pipeline gate reads it
        this.syncPlanModeToConfig()
        if (this.abortController!.signal.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
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
        

        // Step 6b: run compaction (session split, maybeCompact, stale rounds, heap)
        {
          const compactionResult = await rejectOnAbort(
            this.runCompaction(turn, snap),
            this.abortController!.signal,
            'compaction',
          )
          if (compactionResult.shouldAbort) {
            if (!assistantResponded && !compactionResult.userMessageConsumed) this.session.removeLastMessage()
            callbacks.onAbort()
            return
          }
          if (compactionResult.userMessageConsumed) userMessageConsumed = true
        }

        this.streamedText = ''
        this.lastPrewarmAt = 0
        let _tb = Date.now()
        await rejectOnAbort(this.prewarmRecentReads(), this.abortController!.signal, 'prewarm')
        debugLog(`[turn-boundary] turn=${turn} prewarmRecentReads: ${Date.now() - _tb}ms`)

        // ── Git freshness: file change rate (Zeitgeber signal) ──
        getGitChangeRate(this.cwd).then(rate => {
          this.gitChangeRate = smoothChangeRate(rate, this.gitChangeRate)
        }).catch(() => {})

        // ── FS freshness: realtime external Zeitgeber signal ──
        this.latestFsWatcherState = this.fsWatcher?.getState() ?? { eventRate: 0, eventCount: 0, active: false }

        // Step 6c: run perception (sensorium, season, phase class, contract)
        const { sensorium: currentSensorium, strategy: currentStrategy, phaseClass, pressureResult } = await rejectOnAbort(
          this.runPerception(turn, estTokens, actionable, callbacks),
          this.abortController!.signal,
          'perception',
        )

        // Step 6d: run convergence check
        {
          // Wrapped for parity with the other boundary steps: convergence can
          // call trySessionSplit → llmCompact (a network call) whose internal
          // abort cooperation is exactly the unreliable mechanism this commit
          // backstops. Without the race, a watchdog abort can't free a wedge here.
          const { action } = await rejectOnAbort(
            this.runConvergenceCheck(turn, phaseClass, assistantResponded, userMessageConsumed, callbacks),
            this.abortController!.signal,
            'convergence',
          )
          if (action === 'abort') return
        }

        _tb = Date.now()
        // Step 6f: build turn request (intent, repair, context ceiling, cross-session, prompt)
        const turnRequest = await rejectOnAbort(
          this.buildTurnRequest(turn, currentStrategy, currentSensorium, pressureResult, assistantResponded, userMessageConsumed, callbacks),
          this.abortController!.signal,
          'build-request',
        )
        if (turnRequest.action === 'veto') continue
        if (turnRequest.action === 'abort') return
        const request = turnRequest.request!

        // Turn-level thinking (GLM): disable thinking on tool execution turns
        // to reduce reasoning_content accumulation. Enable on planning/analysis turns.
        // This prevents the "200k window stall" where preserved thinking bloats context.
        if (this.config.turnLevelThinking && this.config.client.setThinking) {
          const messages = this.session.getMessages()
          const lastMsg = messages[messages.length - 1]
          const isToolExecTurn = lastMsg?.role === 'tool'
          this.config.client.setThinking(isToolExecTurn ? 'disabled' : 'enabled')
        }

        let turnTextAccum = ''
        let turnThinkingAccum = ''
        let rateLimitOccurred = false
        let rateLimitRetryMs = 0
        const prevThinkingFingerprint = this.lastTurnThinkingFingerprint
        let turnDedupState: 'tracking' | 'flushed' = 'tracking'
        let pendingFlush = ''
        const prevFingerprint = this.lastTurnTextFingerprint

        // L0 streaming-executor telemetry: measure stream + tool execution latency.
        const turnStartMs = Date.now()

        const streamResult = await this.turnStream!.streamTurn({
          request,
          turn,
          lastTurnTextFingerprint: this.lastTurnTextFingerprint,
          streamRules: this.config.streamRules,
          disabledRulePatterns,
          callbacks: {
            onTextDelta: (text) => {
              turnTextAccum += text
              if (turnDedupState === 'flushed') {
                callbacks.onTextDelta(text)
                return
              }
              if (!prevFingerprint) {
                turnDedupState = 'flushed'
                callbacks.onTextDelta(text)
                return
              }
              pendingFlush += text
              const fp = turnTextAccum.replace(/\s+/g, ' ').trim()
              if (!prevFingerprint.startsWith(fp)) {
                // Diverged or extended beyond the previous fingerprint — flush all pending
                // and switch to pass-through. Do not suppress mid-stream: a full match so
                // far may still be followed by new content in a later delta.
                turnDedupState = 'flushed'
                callbacks.onTextDelta(pendingFlush)
                pendingFlush = ''
              }
              // else: still equal to or a prefix of prev fingerprint, keep buffering until stream end
            },
            onThinkingDelta: (thinking) => {
              // Cross-turn thinking fingerprint dedup: if the model repeats
              // thinking from the previous turn verbatim, suppress display.
              // Only suppress exact full-match (not prefixes — early reasoning
              // steps legitimately overlap across turns).
              turnThinkingAccum += thinking
              if (prevThinkingFingerprint && turnThinkingAccum === prevThinkingFingerprint) {
                return // suppress — identical to previous turn's thinking
              }
              callbacks.onThinkingDelta(thinking)
            },
            onToolUse: callbacks.onToolUse,
            onToolHint: (name) => {
              callbacks.onPhaseChange?.('tool-hint', { tool: name, reason: `preparing ${name}…` })
            },
            onStreamStart: () => {
              callbacks.onPhaseChange?.('working', { reason: 'waiting for first token' })
            },
            onError: callbacks.onError,
            onRateLimit: (retryDelayMs) => {
              rateLimitOccurred = true
              rateLimitRetryMs = retryDelayMs ?? 0
            },
          },
        })
        // Only decide full-turn suppression at the stream boundary. A mid-stream exact
        // fingerprint match is not final; later deltas may add new content.
        if (turnDedupState === 'tracking' && pendingFlush) {
          const fp = turnTextAccum.replace(/\s+/g, ' ').trim()
          if (fp !== prevFingerprint) {
            callbacks.onTextDelta(pendingFlush)
          }
        }
        const { collectedBlocks, thinkingAccum, toolUses, stopReason, streamError } = streamResult
        this.lastTurnTextFingerprint = streamResult.lastTurnTextFingerprint
        this.lastTurnThinkingFingerprint = streamResult.lastTurnThinkingFingerprint
        // Track text fingerprints for cross-turn repetition detection
        if (streamResult.lastTurnTextFingerprint.length >= 50) {
          this.recentTextFingerprints.push(streamResult.lastTurnTextFingerprint)
          if (this.recentTextFingerprints.length > 8) this.recentTextFingerprints.shift()
        }

        // TTSR: stream rule triggered — inject reminder and retry, governed
        // by a per-run retry cap so a self-matching task can't loop forever.
        if (streamResult.triggeredRule) {
          const rule = streamResult.triggeredRule
          const count = (ruleTriggerCounts.get(rule.pattern) ?? 0) + 1
          ruleTriggerCounts.set(rule.pattern, count)

          if (count > MAX_RULE_RETRIES) {
            // Cap exceeded: disable this rule for the rest of the run and let
            // the turn proceed normally (the bash tool's own exec-time guard
            // remains as defense-in-depth). Re-enter the loop without injecting.
            disabledRulePatterns.add(rule.pattern)
            debugLog(`[ttsr] rule disabled after ${count - 1} retries: ${rule.pattern}`)
            continue
          }

          // Wrap as a system reminder (not a bare user message) so it is not
          // rendered as a user bubble, and dedup identical consecutive injects.
          // Kept as a trailing user-role append: the expensive cache prefix
          // (tools/system/first-user-message) sits at the head and is never
          // touched, so prompt-cache reuse is preserved across the retry.
          const reminder = `<system-reminder>\n${rule.inject}\n</system-reminder>`
          if (reminder !== lastInjectedReminder) {
            this.session.addUserMessage(reminder)
            lastInjectedReminder = reminder
          }
          // Flush streamed text so the next stream doesn't append on top of
          // existing TUI streamBuf content.
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
          continue
        }

        // Rate-aware backpressure: if the API layer signaled a 429 retry,
        // add an inter-turn delay to avoid hitting the rate limit again
        // before the provider's rate window resets.
        if (rateLimitOccurred) {
          // Use server-provided retry delay when available, otherwise fall back to 2s
          const delayMs = rateLimitRetryMs > 0 ? rateLimitRetryMs : 2000
          await new Promise(r => setTimeout(r, delayMs))
        }

        // L0 telemetry: stream duration
        const streamEndMs = Date.now()
        if (toolUses.length > 0) {
          this.telemetryWriter.write({
            ts: streamEndMs,
            turn,
            phase: 'stream-complete',
            streamDurationMs: streamEndMs - turnStartMs,
            toolCount: toolUses.length,
            toolNames: toolUses.map(tu => tu.name).join(','),
          } as any)
        }

        // Feed CacheAdvisor with turn metrics after API call completes
        // Cache read/creation metrics are captured here; artifact eviction/access
        // metrics are added after tool execution (see below).
        const cacheHistory = this.session.getCacheHistory()
        const latestTurnCache = cacheHistory.length > 0 ? cacheHistory[cacheHistory.length - 1] : null

        if (this.abortController!.signal.aborted) {
          // P0: skip addAssistantBlocks — partial blocks from an aborted
          // stream must not pollute the message list and break prefix cache.
          if (this.streamedText.length > 0) this.session.addUsage({ output_tokens: Math.ceil(this.streamedText.length / 4) })
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          // runPostSession is best-effort cleanup — its failure must not cause
          // the outer catch to double-delete an unrelated message.
          try { await this.runPostSession(callbacks) } catch { /* best-effort */ }
          callbacks.onAbort()
          return
        }

        if (streamError) {
          if (collectedBlocks.length > 0 && (streamError as Error).name !== 'AbortError') { this.session.addAssistantBlocks(collectedBlocks); assistantResponded = true }
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          callbacks.onError(streamError)
          return
        }

        if (collectedBlocks.length > 0) { this.session.addAssistantBlocks(collectedBlocks); assistantResponded = true }

        // max_output_tokens on text-only turns: accept partial output instead of
        // escalating. The model rarely continues coherently — it usually restarts
        // from scratch, causing a confusing "cut off → restart" loop for users.
        // Previously we tried up to 3 escalations; now we just end the turn.

        if (toolUses.length > 0) {
          // Reset no-tool counter — model is taking action
          this.consecutiveNoToolTurns = 0
          // ── Pre-execution diagnostic snapshot ──
          // Write sensorium before tool execution so freeze analysis can
          // identify which tools were about to run, even if executeBatch hangs.
          const toolNames = toolUses.map(tu => tu.name).join(',')
          this.telemetryWriter.write({
            ts: Date.now(),
            turn,
            phase: 'tool-executing',
            tools: toolNames,
            toolCount: toolUses.length,
          } as any)

          const r = await this.toolExecution.executeBatch({
            toolUses, callbacks, turn, checkpointCreatedThisTurn,
            abortSignal: this.abortController!.signal,
            traceStore: this.traceStore, importGraph: this.importGraph,
            lastConflictCheckCount: this.lastConflictCheckCount, latestRisk: this.latestRisk,
          })
          ;({ traceStore: this.traceStore, importGraph: this.importGraph,
             lastConflictCheckCount: this.lastConflictCheckCount, latestRisk: this.latestRisk } = r)
          if (r.checkpointCreated) checkpointCreatedThisTurn = true

          // L0 telemetry: tools duration
          this.telemetryWriter.write({
            ts: Date.now(),
            turn,
            phase: "tools-complete",
            toolsDurationMs: Date.now() - streamEndMs,
            totalTurnMs: Date.now() - turnStartMs,
            toolCount: toolUses.length,
          } as any)

          // Feed CacheAdvisor with cache metrics + artifact eviction/access data
          if (latestTurnCache && latestTurnCache.turn === turn) {
            this.cacheAdvisor.onTurnEnd({
              turn,
              cacheRead: latestTurnCache.cacheRead,
              cacheCreation: latestTurnCache.cacheCreation,
              prefixChanged: latestTurnCache.cacheRead === 0 && turn > 1,
              artifactIdsEvicted: r.artifactIdsEvicted,
              artifactIdsAccessed: r.artifactIdsAccessed,
            })
          }
          this.config.meridianIndexer?.flushTurn()
          await rejectOnAbort(
            this.turnCompletion.complete({ turn, isFinal: false, callbacks }),
            this.abortController!.signal,
            'post-turn',
          )
          continue
        }

        // Thinking-only turn detection: retry if model produced reasoning but no text/tools
        // Feed CacheAdvisor for non-tool turns (no evictions/accesses)
        if (latestTurnCache && latestTurnCache.turn === turn) {
          this.cacheAdvisor.onTurnEnd({
            turn,
            cacheRead: latestTurnCache.cacheRead,
            cacheCreation: latestTurnCache.cacheCreation,
            prefixChanged: latestTurnCache.cacheRead === 0 && turn > 1,
            artifactIdsEvicted: [],
            artifactIdsAccessed: [],
          })
        }
        const thinkingResult = evaluateThinkingRetry({
          streamedText: this.streamedText, collectedBlockCount: collectedBlocks.length,
          thinkingAccum, thinkingOnlyRetries: this.thinkingOnlyRetries,
          lastThinkingContent: this.lastThinkingContent,
        })
        this.lastThinkingContent = thinkingResult.nextState.lastThinkingContent
        this.thinkingOnlyRetries = thinkingResult.nextState.thinkingOnlyRetries
        if (thinkingResult.shouldRetry) {
          this.session.addUserMessage(thinkingResult.retryMessage)
          // Archive any partial streamed text before retrying (same rationale as TTSR above)
          callbacks.onTurnComplete(this.session.getTotalUsage(), this.session.getTurnCount(), false)
          continue
        }

        // No tool calls this turn — increment the counter for convergence detection
        this.consecutiveNoToolTurns++

        this.config.meridianIndexer?.flushTurn()
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
      if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
      if ((err as Error).name === 'AbortError') {
        await this.runPostSession(callbacks)
        callbacks.onAbort()
      } else {
        callbacks.onError(err as Error)
      }
    } finally {
      heartbeat.stop()
      this.stopFsWatcher()
    }
  }

  /**
   * P7: wrap AgentCallbacks so every UI-visible event resets the heartbeat
   * silence clock. Heartbeat fires only during true silent gaps (no text
   * delta, no tool result, no phase change for `silentMs`).
   */
  private wrapCallbacksWithHeartbeat(cb: AgentCallbacks, hb: TurnHeartbeat): AgentCallbacks {
    return {
      ...cb,
      onTextDelta: (text) => { hb.tick('streaming text'); cb.onTextDelta(text) },
      onThinkingDelta: (thinking) => { hb.tick('thinking'); cb.onThinkingDelta(thinking) },
      onToolUse: (id, name, input) => { hb.tick(`calling ${name}`); cb.onToolUse(id, name, input) },
      onToolResult: (id, name, result, isError, rawPath, uiContent) => {
        hb.tick(`${name} returned`)
        cb.onToolResult(id, name, result, isError, rawPath, uiContent)
      },
      onTurnComplete: (usage, turnNumber, isFinal) => {
        hb.tick(`turn ${turnNumber} complete`)
        cb.onTurnComplete(usage, turnNumber, isFinal)
      },
      onPhaseChange: (phase, detail) => {
        // Heartbeat-emitted phases must NOT recursively reset the clock.
        if (phase !== 'heartbeat') hb.tick(`phase: ${phase}`)
        cb.onPhaseChange?.(phase, detail)
      },
    }
  }
}

/**
 * Compute the bitwise XOR complement of a hex string.
 * Each hex digit is XOR'd with 0xf, producing its complement.
 * Used by HEARTH to compute pole_void from pole_structure.
 */
function hexComplement(hex: string): string {
  let result = ''
  for (let i = 0; i < hex.length; i++) {
    result += (0xf ^ parseInt(hex[i]!, 16)).toString(16)
  }
  return result
}
