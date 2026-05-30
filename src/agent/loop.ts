import type { StreamClient } from '../api/stream-client.js'
import type { Usage } from '../api/types.js'
import type { ProviderProfile } from '../api/provider-profile.js'
import { PromptEngine } from '../prompt/engine.js'
import type { ToolHistoryEntry } from '../prompt/volatile.js'
import { getGitInjectedContext } from '../prompt/volatile-git.js'
import { ToolRegistry } from '../tools/registry.js'
import { killAll } from '../tools/process-tracker.js'
import { SessionContext } from './context.js'
import { SessionPersist } from './session-persist.js'
import { extractIntents } from './intent-extractor.js'
import { PrewarmCache } from './prewarm.js'
import { batchPrewarm, buildPrewarmValue } from './prewarm-file.js'
import { type CompactionConfig, staleRoundThresholds } from '../compact/constants.js'
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
import { detectWorktreeReality, type InjectedWorktreeContext } from './worktree-reality.js'
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
import { createAnchorGraph } from '../prompt/anchor-graph.js'
import { createHash } from 'node:crypto'
import { ArtifactStore } from '../artifact/store.js'
import { SessionStateManager } from './session-state.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import { debugLog } from '../utils/debug.js'
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
import { CacheAdvisor } from '../cache/advisor.js'
import { microCompactOai, estimateOaiTokens } from '../compact/micro.js'
import { createSycophancyTrap, type SycophancyTrap } from './sycophancy-trap.js'
import { TurnHeartbeat } from './turn-heartbeat.js'
import { createP3Integration, type P3Integration } from './p3-integration.js'
import type { HealthSignal } from './trajectory-health.js'
import { ImmuneHook } from './immune-hook.js'
import { formatImmuneContext } from './immune-context.js'
import { checkTddGate } from './tdd-gate.js'
import { PhysarumEngine } from '../repo/physarum-engine.js'
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
import type { SensoriumEntry } from './retrospect.js'
import { join } from 'node:path'
import { formatEventsForAppendix } from './hooks/cross-session-hook.js'
import { HeuristicStore } from '../compact/heuristic-store.js'
import { formatHeuristicsForInjection } from '../compact/heuristic-injector.js'

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
  /** Primary model's StreamClient — reused for LLM compaction via Forked Agent pattern. */
  primaryClient?: StreamClient
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
  /** Optional TaskLedger for B1 ownership tracking — records file_read/file_write/tool_exec events. */
  taskLedger?: import('./task-ledger.js').TaskLedger
  /** Explicit opt-in for Songline substrate post-session pheromone/cycle relay. Disabled by default. */
  songlineEnabled?: boolean
  /** Explicit opt-in for HEARTH anchor invariant observation (postTurn, diagnostic only). Disabled by default. */
  hearthObserveEnabled?: boolean
  /** Optional OwnershipLedger for real-time file ownership — updated on every file_write. */
  ownershipLedger?: import('./ownership-ledger.js').OwnershipLedger
  /** Optional Meridian code graph indexer for structural context. */
  meridianIndexer?: import('../repo/meridian-indexer.js').MeridianIndexer | null
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
  private _running = false
  private physarumForWarmup?: PhysarumEngine
  private meridianDbForWarmup?: import('../repo/meridian-db.js').MeridianDb
  private memoriesWarmed = false
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
  /** Previous anchor graph hash for HEARTH INV-5 intra-session drift detection. */
  private prevAnchorGraphHash: string | null = null
  private static readonly MAX_OUTPUT_ESCALATION = 3
  private pressureMonitor: PressureMonitor
  private sycophancyTrap: SycophancyTrap = createSycophancyTrap()
  private sycophancyWasActive = false
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
  private readonly stanceTally = createStanceTally()
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
  private cacheAdvisor: CacheAdvisor
  private p3: P3Integration
  private heuristicStore: HeuristicStore
  private immuneHook: ImmuneHook
  private _lastImmuneHint?: import('./immune-context.js').ImmuneContextHint

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
        try {
          const params = {
            input: { file_path: target, path: target },
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

    this.heuristicStore = new HeuristicStore(join(sessionDir, 'heuristics.jsonl'))

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
      getDomainId: () => this.sessionDomain?.id ?? null,
      getFileObservations: () => this.config.contextClaimStore?.listClaims({ kind: ['file_observation'] }) ?? [],
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
    return new TurnStreamController({
      client: this.config.client,
      abortSignal: this.abortController?.signal ?? new AbortController().signal,
      getStreamedTextLength: () => this.streamedText.length,
      appendStreamedText: text => { this.streamedText += text },
      getLastPrewarmAt: () => this.lastPrewarmAt,
      setLastPrewarmAt: position => { this.lastPrewarmAt = position },
      maybePrewarm: text => { this.maybePrewarm(text) },
      prewarmFile: filePath => {
        const value = buildPrewarmValue(this.cwd, filePath)
        if (value && !this.prewarm.has(value.canonicalPath)) {
          this.prewarm.set(value.canonicalPath, value)
        }
      },
      addUsage: usage => { this.session.addUsage(usage) },
      recordTurnCache: (turn, usage) => {
        this.session.recordTurnCache(turn, usage)
        const hitRate = usage.input_tokens > 0
          ? ((usage.cache_read_input_tokens ?? 0) / usage.input_tokens * 100).toFixed(1)
          : '0.0'
        const sid = this.config.sessionId ?? 'anon'
        const line = JSON.stringify({ t: Date.now(), turn, input: usage.input_tokens, cacheRead: usage.cache_read_input_tokens, cacheCreate: usage.cache_creation_input_tokens, hitRate: `${hitRate}%` })
        import('node:fs/promises').then(fs => {
          const dir = join(this.cwd, '.rivet', 'sessions', sid)
          return fs.mkdir(dir, { recursive: true })
            .then(() => fs.appendFile(join(dir, 'cache-log.jsonl'), line + '\n'))
        }).catch(() => {})
      },
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
      immuneHook: this.immuneHook,
      runtimeHooks: this.runtimeHooks,
      contextInjection: this.contextInjection,
      trajectory: this.trajectory,
      getPredictionAccumulator: () => this.predictionAccumulator,
      setPredictionAccumulator: a => { this.predictionAccumulator = a },
      getVigorState: () => this.vigorState,
      setVigorState: v => { this.vigorState = v },
      getDoomLoopLevel: () => this.getDoomLoopLevel(),
      getPhaseHint: () => this.config.promptEngine.getPhaseHint(),
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
      cacheAdvisor: this.cacheAdvisor,
      p3: this.p3,
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

    // P3 integration: pattern mining + speculative pre-execution
    this.p3.onToolComplete(name, target, isError, isError ? result.slice(0, 200) : undefined)

    // P3-E/H: invalidate plan cache + JIT on file mutations
    if (!isError && (name === 'edit_file' || name === 'write_file')) {
      this.p3.invalidatePlanCache(target)
      this.p3.invalidateJIT(target)
    }

    // P3-D Atropos: assess trajectory health → auto-escalate Flash→Pro on repeated failures
    let trajectoryHealth: HealthSignal = 'healthy'
    if (this.config.onModelSwitch && this.config.getCurrentModel) {
      const currentModelId = this.config.getCurrentModel()
      const tier: 'flash' | 'pro' = currentModelId.includes('pro') ? 'pro' : 'flash'
      if (tier === 'flash') {
        const recentEvents = this.traceStore.events.slice(-10).map(e => ({
          status: (e.status === 'passed' ? 'passed' : 'failed') as 'passed' | 'failed',
          turn: e.turn,
        }))
        trajectoryHealth = this.p3.assessHealth(recentEvents, this.session.getTurnCount(), tier)
        if (trajectoryHealth === 'escalate') {
          const proModel = currentModelId.replace('flash', 'pro')
          try { this.config.onModelSwitch(proModel) } catch { /* non-fatal */ }
        }
      }
    }

    // Physarum + Immune: postTool danger signal collection + adaptive response
    const fp = this.traceStore.toolFingerprints[this.traceStore.toolFingerprints.length - 1] ?? name
    const immuneResult = this.immuneHook.run({
      toolName: name,
      fingerprint: fp,
      turn: this.session.getTurnCount(),
      doomLevel: this.getDoomLoopLevel(),
      targetFile: target,
      tokenUsage: this.session.getEstimatedTokens(),
      trajectoryHealth,
    })
    // Store immune context hint for injection into next agent turn
    if (immuneResult.contextHint) {
      this._lastImmuneHint = immuneResult.contextHint
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
        messageCount: this.session.getMessages().length,
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

  getTaskContract(): TaskContract | undefined { return this.taskContract }

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

  private async runPostSession(callbacks: AgentCallbacks): Promise<void> {
    await this.runtimeHooks.runPostSession(createRuntimeHookContext(this.buildRuntimeSnapshot(),
      { emitPhaseChange: (phase, detail) => { callbacks.onPhaseChange?.(phase, detail) } }))
    // Cleanup old cross-session events (2h TTL)
    if (this.config.sessionRegistry) {
      try { this.config.sessionRegistry.cleanupOldEvents(2 * 60 * 60 * 1000) } catch { /* ignore */ }
    }
    // Heuristic validation: update confidence based on session outcome
    try {
      const hadErrors = this.trajectory.getEntries().some(e => e.status === 'failed')
      const topRules = this.heuristicStore.getTopK(5)
      for (const rule of topRules) {
        this.heuristicStore.recordHit(rule.id)
        this.heuristicStore.updateConfidence(rule.id, !hadErrors)
      }
      this.heuristicStore.prune()
      await this.heuristicStore.save()
    } catch { /* non-critical */ }

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
    try { this.immuneHook.importMemories(db.loadImmuneMemories()) } catch { /* non-critical */ }
    try { this.p3?.notebook.importEntries(db.loadMistakeEntries()) } catch { /* non-critical */ }
  }

  private async _runInner(userInput: string, callbacks: AgentCallbacks): Promise<void> {
    await this.warmupMemories()
    this.abortController = new AbortController()
    await this.startFsWatcher()
    // P7: heartbeat watchdog — surfaces "still working" signal during long
    // silent operations so the UI doesn't appear frozen and users don't
    // interrupt the agent mid-task.
    const heartbeat = new TurnHeartbeat({
      silentMs: 20_000,
      repeatMs: 15_000,
      onHeartbeat: (elapsed, lastActivity) => {
        const seconds = Math.round(elapsed / 1000)
        callbacks.onPhaseChange?.('heartbeat', {
          reason: `still working — last activity: ${lastActivity} (${seconds}s ago)`,
        })
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

    // Load cross-session heuristic rules for injection
    try {
      await this.heuristicStore.load()
      const topRules = this.heuristicStore.getTopK(5)
      this.config.promptEngine.setHeuristicRules(formatHeuristicsForInjection(topRules) || null)
    } catch {
      this.config.promptEngine.setHeuristicRules(null)
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

    if (this.config.autoReasoning && actionable) {
      this.config.reasoningEffort = selectReasoningEffort(userInput, this.config.reasoningFloor)
      this.config.client.setReasoningEffort?.(this.config.reasoningEffort)
    }

    let checkpointCreatedThisTurn = false

    // Track whether any assistant response was produced this turn.
    // If the turn is aborted before any assistant output, we roll back
    // the user message so it doesn't pollute context on retry.
    let assistantResponded = false
    // Track whether compaction consumed the user message (session split /
    // LLM compact replace the message list). When true, skip removeLastMessage
    // because the user message no longer exists at the top of the stack.
    let userMessageConsumed = false

    try {
      for (let turn = 0; turn < this.config.maxTurns; turn++) {
        if (this.abortController.signal.aborted) {
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
        
        
        // Phase 2.3: Proactive session split at 86% context.
        // Replaces message history with cache anchors + handoff,
        // preserving exact prefix for DeepSeek disk cache hits.
        // When split succeeds, the session is already pruned to
        // ~3 messages → all subsequent compaction is a no-op.
        if (await this.compaction.trySessionSplit()) {
          userMessageConsumed = true
        }
        // A2: user may have aborted during trySessionSplit (which can trigger
        // 60s LLM compact). Bail early instead of continuing into maybeCompact.
        if (this.abortController.signal.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          callbacks.onAbort()
          return
        }

        const compactResult = await this.compaction.maybeCompact({
          loopTurn: turn,
          failures: this.compactFailures,
        })
        if (compactResult.compacted) userMessageConsumed = true
        // A2: bail after maybeCompact (can also trigger LLM compact on 1M windows)
        if (this.abortController.signal.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          callbacks.onAbort()
          return
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
        // run phase 1 only (tool content + reasoning truncation).
        // Never delete entire rounds — assistant reasoning is a scarce asset.
        const heapRatio = snap
          ? snap.memory.heapUsedBytes / snap.memory.memoryLimitBytes
          : 0
        if (!compactResult.compacted && heapRatio >= 0.6 && this.session.getMessages().length >= 10) {
          // P3 trace: verify phase 2 (round deletion) is blocked, phase 1 only
          debugLog(`[memory-pressure] heap=${heapRatio.toFixed(2)} phase2-blocked=true msgCount=${this.session.getMessages().length}`)
          const before = this.session.getMessages()
          // Pass full contextWindow so phase 2 (round removal) never triggers.
          // Phase 1 (tool_result + reasoning_content truncation) still applies.
          const contextWindow = this.config.contextWindow ?? 1_000_000
          // Phase 2.1: On 1M+ windows, skip heap-driven micro compact to
          // preserve exact prefix cache. Memory pressure is resolved via
          // enforceContextCeiling (95% ceiling) as emergency last resort.
          if (contextWindow < 1_000_000) {
            const { messages: trimmed } = microCompactOai(before, contextWindow, this.session.getEstimatedTokens())
            if (trimmed.length < before.length || trimmed !== before) {
              this.session.replaceMessages(trimmed)
              if (typeof globalThis.gc === 'function') globalThis.gc()
            }
          }
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
        if (!actionable) {
          this.config.promptEngine.setCognitiveProjection(null)
          this.config.promptEngine.setTaskProgress({ completed: [], current: 'chat-mode', remaining: [], decisions: [] })
        }
        callbacks.onPhaseChange?.('preparing', { reason: 'preparing next turn' })
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

        await this.compaction.enforceContextCeiling()
        // A2: enforceContextCeiling can trigger LLM compact (30s timeout).
        if (this.abortController.signal.aborted) {
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          callbacks.onAbort()
          return
        }
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
              turn: this.session.getTurnCount(),
              source: 'sycophancy-trap',
            })
          } catch { /* non-critical */ }
        }
        this.sycophancyWasActive = sycActive

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
        const request = this.config.promptEngine.buildOaiRequest(
          this.session.getMessages(),
          this.recentToolHistory,
          this.config.contextWindow,
        )
        let turnTextAccum = ''
        let turnDedupState: 'tracking' | 'flushed' = 'tracking'
        let pendingFlush = ''
        const prevFingerprint = this.lastTurnTextFingerprint

        const streamResult = await this.turnStream!.streamTurn({
          request,
          turn,
          lastTurnTextFingerprint: this.lastTurnTextFingerprint,
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
            onThinkingDelta: callbacks.onThinkingDelta,
            onToolUse: callbacks.onToolUse,
            onToolHint: (name) => {
              callbacks.onPhaseChange?.('tool-hint', { tool: name, reason: `preparing ${name}…` })
            },
            onStreamStart: () => {
              callbacks.onPhaseChange?.('working', { reason: 'waiting for first token' })
            },
            onError: callbacks.onError,
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

        // Feed CacheAdvisor with turn metrics after API call completes
        // Cache read/creation metrics are captured here; artifact eviction/access
        // metrics are added after tool execution (see below).
        const cacheHistory = this.session.getCacheHistory()
        const latestTurnCache = cacheHistory.length > 0 ? cacheHistory[cacheHistory.length - 1] : null

        if (this.abortController.signal.aborted) {
          if (collectedBlocks.length > 0) { this.session.addAssistantBlocks(collectedBlocks); assistantResponded = true }
          if (this.streamedText.length > 0) this.session.addUsage({ output_tokens: Math.ceil(this.streamedText.length / 4) })
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          // runPostSession is best-effort cleanup — its failure must not cause
          // the outer catch to double-delete an unrelated message.
          try { await this.runPostSession(callbacks) } catch { /* best-effort */ }
          callbacks.onAbort()
          return
        }

        if (streamError) {
          if (collectedBlocks.length > 0) { this.session.addAssistantBlocks(collectedBlocks); assistantResponded = true }
          if (!assistantResponded && !userMessageConsumed) this.session.removeLastMessage()
          callbacks.onError(streamError)
          return
        }

        if (collectedBlocks.length > 0) { this.session.addAssistantBlocks(collectedBlocks); assistantResponded = true }

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
          await this.turnCompletion.complete({ turn, isFinal: false, callbacks })
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
          continue
        }

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
