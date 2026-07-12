import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
import { createVirtueSettlementHook } from './hooks/virtue-settlement-hook.js'
import { createSignalConsumerRuntimeHook } from './hooks/signal-consumer-hook.js'
import { createPlaybookReflectHook } from './hooks/playbook-reflect-hook.js'
import { createAnchorBreakShadowHook } from './hooks/anchor-break-shadow-hook.js'
import { createAnchorBreakScoutHook, type AnchorBreakScoutConfig } from './hooks/anchor-break-scout-hook.js'
import type { DelegationCoordinator } from './coordinator.js'
import { createTelemetryFlushHook } from './hooks/telemetry-flush-hook.js'
import { createPhysarumShadowTelemetryHook } from './hooks/physarum-shadow-telemetry-hook.js'
import { createDreamHook } from './hooks/dream-hook.js'
import { createSkillDistillHook } from './hooks/skill-distill-hook.js'
import { createCourageHook } from './hooks/courage-hook.js'
import { createRadioHook, type RadioHookDeps } from './hooks/radio-hook.js'
import { createConsistencyCheckHook } from './hooks/consistency-check-hook.js'
import { createMeridianHook, type MeridianHookDeps } from './hooks/meridian-hook.js'
import { createPhysarumFileAccessHook, type PhysarumFileAccessHookDeps } from './hooks/physarum-file-access-hook.js'
import { createSonglineRuntimeHook } from './hooks/songline-hook.js'
import { createConstellationRuntimeHook } from './hooks/constellation-hook.js'
import { createHearthObserveHook } from './hooks/hearth-observe-hook.js'
import { createDedupGuardHook, type DedupGuardHookDeps } from './hooks/dedup-guard-hook.js'
import { createBlindExplorationHook } from './hooks/blind-exploration-hook.js'
import { createMCTSPlanningHook } from './hooks/mcts-planning-hook.js'
import { createDispatcherHook, type DispatcherHookDeps } from './hooks/dispatcher-hook.js'
import { createMemoryLearningPostTurnHook, type MemoryLearningHookDeps } from './hooks/memory-learning-hook.js'
import { createUserHooksBridge, type UserHooksBridgeDeps } from './hooks/user-hooks-bridge.js'
import { createCompanionHeartbeatHook } from './hooks/companion-heartbeat-hook.js'
import { createCcrHook, type CcrTriggerEvent } from './hooks/cognitive-capsule-router.js'
import { createSelfVerifyHook } from './hooks/self-verify-hook.js'
import { createPostCommitReviewPreTurnHook, createPostCommitReviewPostToolHook } from './hooks/post-commit-review-hook.js'
import { createTypecheckReminderHook } from './hooks/typecheck-reminder-hook.js'
import { createTodoReminderHook } from './hooks/todo-reminder-hook.js'
import { createBackgroundJobsHook } from './hooks/background-jobs-hook.js'
import { createEditToolAdvisoryHook } from './hooks/edit-tool-advisory-hook.js'
import { createEditFailureRecoveryHook } from './hooks/edit-failure-recovery-hook.js'
import { createLossyObservationHook } from './hooks/lossy-observation-hook.js'
import { createPointerRegurgitationHook } from './hooks/pointer-regurgitation-hook.js'
import { createErrorDiagnosisHook } from './hooks/error-diagnosis-hook.js'
import { createProbeTrackingHook } from './hooks/probe-tracking-hook.js'
import { createExternalClaimTrackingHook } from './hooks/external-claim-tracking-hook.js'
import { createGeneralLedgerHook } from './hooks/general-ledger-hook.js'
import { createGitClearAfterFailHook } from './hooks/git-clear-after-fail-hook.js'
import { createDeadEndDetectorHook } from './hooks/dead-end-detector.js'
import { createBatchConvergenceHook } from './hooks/batch-convergence-hook.js'
import { createRegressionBisectHook } from './hooks/regression-bisect-hook.js'
import { createIntentAnchorHook } from './hooks/intent-anchor-hook.js'
import { createTurnBudgetHook } from './hooks/turn-budget-hook.js'
import { createReasoningSpiralHook } from './hooks/reasoning-spiral-hook.js'
import { createAdvisoryReadbackHooks } from './hooks/advisory-readback-hook.js'
import { createAsyncCopilotHook, type CopilotContextPack } from './hooks/async-copilot-hook.js'
import { createLanguageAnchorHook } from './hooks/language-anchor-hook.js'
import { createContextPressureHook } from './hooks/context-pressure-hook.js'
import { createGateBlockGuardHook } from './hooks/gate-block-guard-hook.js'
import { createRenderVerifyHook, type RenderVerifyHookDeps } from './hooks/render-verify-hook.js'
import { createWrapupAnxietyGuardHook } from './hooks/wrapup-anxiety-guard-hook.js'
import { createSpecVerifyGateHook } from './hooks/spec-verify-gate-hook.js'
import { createWalkthroughRecorderHooks, type WalkthroughRecorderDeps } from './hooks/walkthrough-recorder.js'
import type { AdvisoryBus } from './advisory-bus.js'
import type { AntiAnchoringConfig } from './anti-anchoring-config.js'
import type { AnchorGraph } from '../prompt/anchor-graph.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput } from './retrospect.js'
import type { DoomLoopLevel } from './trace-store.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import type { EvidenceState } from './evidence.js'
import type { TaskLedgerSummary } from './task-ledger.js'
import type { ChronicleEntry } from './chronicle.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { DomainVoiceId } from './domain-voice.js'
import type { ContextClaim } from '../context/claims.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'
import type { PhysarumShadowStats } from '../repo/physarum-shadow-stats.js'

export interface RuntimeHookDeps {
  stigmergyDeposit: (deposit: any) => Promise<void>
  stigmergyQuery: () => Promise<any>
  getEvidenceState: () => EvidenceState
  setLoadedPheromones: (pheromones: any) => void
  recordStance?: (signal: import('./virtue-signals.js').VirtueSignal) => void
  /** T2: 美德 pending 台账——stigmergy-hook submit, settlement hook drainSettled */
  virtuePendingLedger?: import('./virtue-signals.js').VirtuePendingLedger
  /** T2/T0: 当前季节（settlement hook 季节鼓励门用） */
  getCurrentSeason?: () => import('./cognitive-season.js').CognitiveSeason
  /** T3: 季节强度 */
  getCurrentSeasonIntensity?: () => number
  /** T0: 近 N 轮平均缓存命中率（信复活用） */
  getRecentCacheHitRate?: () => number | null
  getThetaState: () => any
  setThetaState: (state: any) => void
  getPredictionAccumulator: () => any
  telemetryWriter?: TelemetryWriter
  /** Runtime-only aggregate of Physarum shadow prediction observations. Never injected into prompts. */
  getPhysarumShadowStats?: () => PhysarumShadowStats
  /** Publish cross-session event (file changes, type errors, etc.) */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** Current session ID for event attribution */
  sessionId?: string
  dream?: {
    cwd: string
    sessionId: string
    getDecisions: () => string[]
    getTrajectory: () => TrajectoryEntry[]
    getFailureJournal?: () => import('./failure-journal.js').FailureJournal
  }
  playbookStore?: PlaybookStore
  /** Live registry skills (name+triggers) for skill-distill dedup. */
  getRegisteredSkills?: () => Array<{ name: string; triggers: RegExp[] }>
  /** Disable session-end skill draft distillation. Default: enabled when dream deps exist. */
  skillDistillDisabled?: boolean
  buildRetrospectInput?: () => RetrospectInput
  getDoomLoopLevel?: () => DoomLoopLevel
  /** Whether convergence detection injected a kick this turn — used for kick-hook mutual exclusion. */
  wasConvergenceTriggered?: () => boolean
  /** SessionRegistry for cross-session fingerprint storage (playbook-reflect). */
  sessionRegistry?: import('./session-registry.js').SessionRegistry
  /** Current working directory — used for project-scoped fingerprint partitioning. */
  cwd?: string
  chronicle?: { addRadio: (message: string, turn: number) => void; addPhaseTransition: (input: { fromPhase: string; toPhase: string; turn: number; summary: string }) => void }
  /** Returns current star domain id for radio voice modulation. null when no domain matched. */
  getDomainId?: () => DomainVoiceId
  /** File observation claims for cross-store consistency checks. */
  getFileObservations?: () => Array<Pick<ContextClaim, 'id' | 'text' | 'evidence'>>
  /** Meridian code graph indexer (optional). */
  meridianIndexer?: MeridianIndexer | null
  /** Physarum topology learner for canonical file access sequences. */
  physarumFileAccess?: PhysarumFileAccessHookDeps
  /** Explicit opt-in for Songline substrate post-session deposit. Default: false. */
  songlineEnabled?: boolean
  /** Task summary source for Songline substrate. Required only when songlineEnabled is true. */
  getTaskSummary?: () => TaskLedgerSummary | null
  /** Optional cycle relay bridge for Songline substrate. */
  setCycleClose?: (sessionId: string, closeHash: string) => void

  // ── Project Constellation (post-session milestone capture) ──
  /** Explicit opt-in for auto milestone capture. Default: false. */
  constellationEnabled?: boolean
  /** Project root for `.rivet/constellation.json`. */
  constellationCwd?: string
  /** Optional chronicle entries source for milestone summary/files. */
  getChronicleEntries?: () => readonly ChronicleEntry[]
  /** Agent's self-chosen departure mark (leave_mark tool), recorded at close. */
  getConstellationPendingMark?: () => import('../tools/types.js').LeaveMarkInput | null
  /** Session numeric id for departure mark consistency. */
  getConstellationNumericId?: () => number | null

  // ── Companion Presence (postTurn heartbeat → .rivet/presence.json) ──
  /** Opt-in for companion heartbeat hook. Default: false (only useful with multiple concurrent sessions). */
  companionPresenceEnabled?: boolean
  /** Project root for `.rivet/presence.json`. */
  companionPresenceCwd?: string
  /** Cognitive state accessor for heartbeat payload. */
  getCognitiveSnapshot?: () => { vigor: number; stability: number; season: string; convergencePrecision?: number; outputEfficiency?: number } | null
  /** Current task objective for heartbeat. */
  getObjective?: () => string | null

  // ── Anti-anchoring (explicit opt-in, prompt-flow intervention) ──
  /** Explicit opt-in for anti-anchoring harness hooks. Default: disabled. */
  antiAnchoring?: AntiAnchoringConfig
  /** Returns the original user task for MCTS planning. */
  getInitialUserMessage?: () => string | null
  /** Lightweight seed model call for MCTS planning branches. */
  callAntiAnchoringSeedModel?: (prompt: string) => Promise<string>
  /** Observe MCTS planning result for diagnostics/tests. */
  onAntiAnchoringMCTSResult?: Parameters<typeof createMCTSPlanningHook>[0]['onResult']

  // ── DEDUP guard (postTurn: detect repeated summaries) ──
  /** Get the current turn's streamed assistant text. */
  getStreamedText?: () => string
  /** Get the previous turn's streamed assistant text. */
  getPrevStreamedText?: () => string | null
  /** Store the current turn's streamed text for next turn comparison. */
  setPrevStreamedText?: (text: string) => void
  /** Overlap ratio threshold (0-1). Default: 0.6 */
  dedupGuardThreshold?: number

  // ── HEARTH observe (pure diagnostic, no intervention) ──
  /** Explicit opt-in for HEARTH anchor invariant observation. Default: false. */
  hearthObserveEnabled?: boolean
  /** Build the current anchor graph from runtime state. */
  getAnchorGraph?: () => AnchorGraph
  /** Previous graph hash for INV-5 intra-session drift detection. */
  getPrevAnchorGraphHash?: () => string | null
  /** Store current graph hash for next turn INV-5. */
  setPrevAnchorGraphHash?: (hash: string) => void
  /** Previous session cycle_open for INV-4 perturbation check. */
  getPrevCycleOpen?: () => string | null
  /** Previous session cycle_close for INV-2 relay check. */
  getPrevSessionCycleClose?: () => string | null

  // ── Auto-delegation (lazy getter, wired by main.tsx via loop.ts) ──
  /** Optional dispatcher hook deps. When set, enables auto-delegation of exploration tasks. */
  autoDelegate?: DispatcherHookDeps
  /** Cross-session memory learning (postTurn observation extraction). */
  memoryLearning?: MemoryLearningHookDeps
  /** User-defined .rivet/hooks.json shell scripts. */
  userHooksBridge?: UserHooksBridgeDeps
  /** A1: unified advisory bus for noise-gated corrective signals */
  advisoryBus?: AdvisoryBus
  /** Background job registry accessor — enables the preTurn background-jobs
   *  awareness nudge. Absent → hook not installed. */
  getJobs?: () => import('../tools/job-store.js').JobRegistry | undefined
  /** 多会话隔离：读取本会话 TodoStore（透传给 todo-reminder 做快照/活跃度判断）。
   *  缺省时 todo-reminder 回退全局 getTodos()。 */
  getTodos?: () => import('../tools/todo-store.js').TodoItem[]
  /** CCR telemetry callback — invoked on each capsule router trigger for offline analysis. */
  onCcrTrigger?: (event: CcrTriggerEvent) => void
  /** P1a 核销闭环：advisory 采纳核销器（loop.advisoryReadback）。缺省 → 不装核销 hook。 */
  advisoryReadback?: import('./advisory-readback.js').AdvisoryReadback
  /** P1a：核销判定后的会话累计回调（guardian meta 接线） */
  onAdvisoryOutcomes?: (totals: { adopted: number; ignored: number }) => void
  /** Phase 3 异步副驾：cheap model 情境合成。缺省 → 不装副驾 hook。 */
  asyncCopilot?: {
    getContext: () => CopilotContextPack
    /** resolve null = cheap client 不可用（副驾永久休眠） */
    complete: (system: string, user: string) => Promise<string | null>
  }
  /** Sycophancy trap — courage-hook consumes its cumulative state for constitutional override */
  sycophancyTrap?: import('./sycophancy-trap.js').SycophancyTrap

  // ── Context pressure advisory ──
  /** Estimated token count (used by context-pressure-hook for ratio warning). */
  getEstimatedTokens?: () => number
  /** Context window size (used by context-pressure-hook for ratio warning). */
  getContextWindow?: () => number

  // ── W2 被拦不弃守护 ──
  /** 读取并清零本 turn 的闸门拦截事件 kind 列表（loop.gateBlockedKinds）。 */
  drainGateBlockedKinds?: () => string[]

  // ── W5 渲染自检 ──
  /** 检查 browser/computer_use 是否已注册（能力降级分支）。 */
  getVisualToolsAvailable?: () => boolean

  // ── P2 break-anchor scout (preTurn, opt-in real intervention) ──
  /** Present only when antiAnchoring + anchorBreakScout are both enabled and a coordinator exists. */
  anchorBreakScout?: {
    config: AnchorBreakScoutConfig
    getCoordinator: () => DelegationCoordinator | null
    getAbortSignal?: () => AbortSignal | undefined
  }

  // ── 主控工作流缺口 C/D(intent-anchor / turn-budget,2026-07-04) ──
  /** 当前 run 的 orchestrator 循环轮数(每 run 从 0 重计)。 */
  getRunTurn?: () => number
  /** 最近一次用户输入(run 启动 = 0,steer 注入更新)的 run 轮数。 */
  getLastUserInputRunTurn?: () => number
  /** 意图锚点复合源:taskContract?.objective ?? initialUserMessage(截 500 字)。 */
  getIntentObjective?: () => string | null
  /** run 的 maxTurns 预算(turn-budget 预警)。 */
  getMaxTurns?: () => number

  // ── 轮内防御三层加固（2026-07）──
  /** 注入 system-reminder 到消息流末尾（不经 advisory bus 优先级竞争）。 */
  addSystemReminder?: (content: string) => void

  // ── 运行走查工件（付费版 v1 · T1）──
  /** computer_use 步骤时间线记录器 + postSession walkthrough 工件组装。
   *  缺省（无 ArtifactStore 通道）→ 不装 hook。 */
  walkthrough?: WalkthroughRecorderDeps
}

export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  // Phase contract (guarded by hook-sensorium-ordering.test.ts): perception stays
  // in preTurn; vigor hooks stay in afterPerception/postTool. The sensorium they
  // consume is produced by the TurnPerceptionController between phases, so vigor's
  // dependency is satisfied by phase separation — not by array order here. Vigor
  // also no-ops when sensorium is absent, so a misorder degrades safely. Keep both
  // properties when adding/reordering hooks.
  const hooks: RuntimeHook[] = [
    createPerceptionRuntimeHook(),
    createSignalConsumerRuntimeHook({ advisoryBus: deps.advisoryBus }),
    ...(isStarSoulEnabled() ? [createCourageHook({ cooldownTurns: 5, courageThreshold: 0.5, sycophancyTrap: deps.sycophancyTrap, advisoryBus: deps.advisoryBus })] : []),
    createKickRuntimeHook({
      deposit: deps.stigmergyDeposit,
      wasConvergenceTriggered: deps.wasConvergenceTriggered,
      advisoryBus: deps.advisoryBus,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
    }),
    createVigorAfterPerceptionHook(),
    createThetaRuntimeHook({
      getThetaState: deps.getThetaState,
      setThetaState: deps.setThetaState,
    }),
    createStigmergyRuntimeHook({
      deposit: deps.stigmergyDeposit,
      query: deps.stigmergyQuery,
      getEvidenceState: deps.getEvidenceState,
      setLoadedPheromones: deps.setLoadedPheromones,
      recordStance: deps.recordStance,
      publishEvent: deps.publishEvent,
      sessionId: deps.sessionId,
      pendingLedger: deps.virtuePendingLedger,
    }),
    ...(deps.getFileObservations
      ? [createConsistencyCheckHook({ getFileObservations: deps.getFileObservations })]
      : []),
    ...(deps.antiAnchoring?.enabled && deps.antiAnchoring.blindExploration
      ? [createBlindExplorationHook({ activeTurns: [deps.antiAnchoring.planningTurn] })]
      : []),
    ...(deps.antiAnchoring?.enabled && deps.antiAnchoring.mctsPlanning && deps.callAntiAnchoringSeedModel && deps.getInitialUserMessage
      ? [createMCTSPlanningHook({
        callSeedModel: deps.callAntiAnchoringSeedModel,
        branches: deps.antiAnchoring.branches,
        planningTurn: deps.antiAnchoring.planningTurn,
        threshold: deps.antiAnchoring.projectionThreshold,
        getUserMessage: deps.getInitialUserMessage,
        onResult: deps.onAntiAnchoringMCTSResult,
      })]
      : []),
    createVigorPostToolHook({
      getPredictionAccumulator: deps.getPredictionAccumulator,
    }),
    createRadioHook({ chronicle: deps.chronicle, getDomainId: deps.getDomainId }),
  ]

  if (deps.playbookStore && deps.buildRetrospectInput && deps.getDoomLoopLevel) {
    hooks.push(createPlaybookReflectHook({
      store: deps.playbookStore,
      buildRetrospectInput: deps.buildRetrospectInput,
      getDoomLoopLevel: deps.getDoomLoopLevel,
      registry: deps.sessionRegistry,
      sessionId: deps.sessionId,
      cwd: deps.cwd,
    }))
  }

  // Anchor-break shadow (P1, observe-only): records "under-explored convergence"
  // candidates at session end. Always registered when retrospect is available;
  // no-ops when the meridian DB store is absent. Never mutates the session.
  if (deps.buildRetrospectInput && deps.sessionId) {
    hooks.push(createAnchorBreakShadowHook({
      store: deps.meridianIndexer?.getDb() ?? null,
      buildRetrospectInput: deps.buildRetrospectInput,
      getSessionId: () => deps.sessionId,
      getObjective: deps.getObjective,
      getActiveDomainId: deps.getDomainId ? () => deps.getDomainId!() ?? null : undefined,
    }))
  }

  // P2 break-anchor scout: real orthogonal-domain sub-agent dispatched mid-loop
  // when a complex task is converging without breadth exploration. Opt-in only.
  if (deps.anchorBreakScout?.config.enabled && deps.sessionId) {
    hooks.push(createAnchorBreakScoutHook({
      config: deps.anchorBreakScout.config,
      getCoordinator: deps.anchorBreakScout.getCoordinator,
      getSessionId: () => deps.sessionId,
      getObjective: deps.getObjective ?? (() => null),
      getActiveDomainId: deps.getDomainId ? () => deps.getDomainId!() ?? null : undefined,
      getDoomLoopLevel: deps.getDoomLoopLevel,
      getAbortSignal: deps.anchorBreakScout.getAbortSignal,
      store: deps.meridianIndexer?.getDb() ?? null,
    }))
  }

  if (deps.dream) {
    hooks.push(createDreamHook({
      cwd: deps.dream.cwd,
      sessionId: deps.dream.sessionId,
      getEvidenceState: deps.getEvidenceState,
      getDecisions: deps.dream.getDecisions,
      getTrajectory: deps.dream.getTrajectory,
      getFailureJournal: deps.dream.getFailureJournal,
      getPlaybookStore: deps.playbookStore ? () => deps.playbookStore : undefined,
    }))

    // Skill-distill: same postSession source as dream — verified, repeatable
    // procedures are distilled into review-only SKILL.md drafts.
    if (!deps.skillDistillDisabled) {
      hooks.push(createSkillDistillHook({
        cwd: deps.dream.cwd,
        sessionId: deps.dream.sessionId,
        getEvidenceState: deps.getEvidenceState,
        getDecisions: deps.dream.getDecisions,
        getTrajectory: deps.dream.getTrajectory,
        getRegisteredSkills: deps.getRegisteredSkills,
        getObjective: deps.getObjective,
      }))
    }
  }

  if (deps.telemetryWriter && deps.getPhysarumShadowStats) {
    hooks.push(createPhysarumShadowTelemetryHook({
      getStats: deps.getPhysarumShadowStats,
      telemetryWriter: deps.telemetryWriter,
    }))
  }

  if (deps.telemetryWriter) {
    hooks.push(createTelemetryFlushHook(deps.telemetryWriter))
  }

  if (deps.meridianIndexer !== undefined) {
    const indexerRef = deps.meridianIndexer
    hooks.push(createMeridianHook({ getIndexer: () => indexerRef }))
  }

  if (deps.physarumFileAccess) {
    hooks.push(createPhysarumFileAccessHook(deps.physarumFileAccess))
  }

  if (deps.songlineEnabled && deps.getTaskSummary) {
    hooks.push(createSonglineRuntimeHook({
      enabled: true,
      getTaskSummary: deps.getTaskSummary,
      deposit: deps.stigmergyDeposit,
      sessionId: deps.sessionId,
      setCycleClose: deps.setCycleClose,
    }))
  }

  if (deps.constellationEnabled && deps.constellationCwd && deps.sessionId) {
    hooks.push(createConstellationRuntimeHook({
      enabled: true,
      cwd: deps.constellationCwd,
      sessionId: deps.sessionId,
      getPendingMark: deps.getConstellationPendingMark,
      getTaskSummary: deps.getTaskSummary,
      getChronicleEntries: deps.getChronicleEntries,
      getDomainId: deps.getDomainId,
      getNumericId: deps.getConstellationNumericId,
    }))
  }

  if (deps.hearthObserveEnabled && deps.getAnchorGraph && deps.getPrevAnchorGraphHash && deps.setPrevAnchorGraphHash) {
    hooks.push(createHearthObserveHook({
      enabled: true,
      getAnchorGraph: deps.getAnchorGraph,
      getPrevGraphHash: deps.getPrevAnchorGraphHash,
      setPrevGraphHash: deps.setPrevAnchorGraphHash,
      getPrevCycleOpen: deps.getPrevCycleOpen ?? (() => null),
      getPrevSessionCycleClose: deps.getPrevSessionCycleClose ?? (() => null),
    }))
  }

  if (deps.getStreamedText && deps.getPrevStreamedText && deps.setPrevStreamedText) {
    hooks.push(createDedupGuardHook({
      getStreamedText: deps.getStreamedText,
      getPrevStreamedText: deps.getPrevStreamedText,
      setPrevStreamedText: deps.setPrevStreamedText,
      threshold: deps.dedupGuardThreshold,
      advisoryBus: deps.advisoryBus,
    }))
  }

  // CCR: Cognitive Capsule Router — star-domain advisory routing
  if (deps.advisoryBus && isStarSoulEnabled()) {
    hooks.push(createCcrHook({
      advisoryBus: deps.advisoryBus,
      wasConvergenceTriggered: deps.wasConvergenceTriggered ?? (() => false),
      getEvidenceState: deps.getEvidenceState,
      cwd: deps.cwd,
      onTrigger: deps.onCcrTrigger,
    }))
  }

  // Self-Verify: postTurn hook — when a turn uses only read-class tools
  // with no ground-truth verification, inject a reminder for the next turn
  // to self-verify before building on the conclusions.
  if (deps.advisoryBus) {
    hooks.push(createSelfVerifyHook({
      advisoryBus: deps.advisoryBus,
      getEvidenceState: deps.getEvidenceState,
    }))
  }

  // Post-Commit Review delivery: preTurn + postTool 双相排水 — deliver_task
  // 把系统触发的提交后审查分离到后台跑（240s 超时事故链修复 2026-07-07），
  // 结论经 post-commit-review-queue 在这里投递回对话。
  if (deps.advisoryBus) {
    hooks.push(createPostCommitReviewPreTurnHook({ advisoryBus: deps.advisoryBus }))
    hooks.push(createPostCommitReviewPostToolHook({ advisoryBus: deps.advisoryBus }))
  }

  // Edit-Tool Advisory: postTool hook — detects consecutive hash_edit calls
  // on the same file (the #1 cause of bracket-mismatch debris). Uses a
  // turn-scoped Map to avoid the 5-entry recentToolHistory window limit.
  // Gated by RIVET_EDIT_SMART_ROUTING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_EDIT_SMART_ROUTING !== '0') {
    hooks.push(createEditToolAdvisoryHook({ advisoryBus: deps.advisoryBus }))
  }

  // Edit-Failure Recovery: postTool hook — detects consecutive edit failures
  // on the same file across turns and injects a repair advisory telling the
  // agent to undo, re-read, and switch to apply_patch/write_file.
  if (deps.advisoryBus) {
    hooks.push(createEditFailureRecoveryHook({ advisoryBus: deps.advisoryBus }))
  }

  // Lossy Observation: postTool hook — detects collapsed/truncated tool
  // output and reinforces the discipline that lossy observations cannot
  // support negative conclusions. Complements guardLossyToolResult's
  // inline VERIFICATION_REQUIRED marker (which only fires on lossy + negative).
  if (deps.advisoryBus) {
    hooks.push(createLossyObservationHook({ advisoryBus: deps.advisoryBus }))
  }

  // Pointer-Regurgitation: postTool hook — counts pointer-guard rejections
  // (model echoing "[file written to …]"-style placeholders as real content)
  // session-wide and escalates to a constitutional advisory from the 2nd
  // offense. The inline guard error alone failed to break a ~20-rejection
  // imitation loop (word-batch report 2026-07-06).
  if (deps.advisoryBus) {
    hooks.push(createPointerRegurgitationHook({ advisoryBus: deps.advisoryBus, addSystemReminder: deps.addSystemReminder }))
  }

  // Error Diagnosis: postTool hook — when a tool fails, reads the
  // failureClass (already classified by tool-execution.ts via
  // failure-classifier.ts) and injects a scenario-specific diagnosis
  // into the advisory stream. Replaces the static error-to-user
  // translation table in the system prompt — knowledge is injected
  // on-demand instead of occupying prompt space permanently.
  if (deps.advisoryBus) {
    hooks.push(createErrorDiagnosisHook({ advisoryBus: deps.advisoryBus }))
  }

  // Probe-Tracking: postTool hook — detects debug probes (console.log,
  // debugger, .only) in write operations. Session-scoped tracker survives
  // across turns; deliver-task gate does authoritative fs re-scan.
  // Gated by RIVET_PROBE_TRACKING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_PROBE_TRACKING !== '0') {
    hooks.push(createProbeTrackingHook({ advisoryBus: deps.advisoryBus }))
  }

  // External-Claim Tracking: postTool hook — detects delegate_task/batch
  // results containing file:line references, then warns if the agent edits
  // those paths without independent verification (read_file/grep) first.
  // Session-scoped claim set with TTL. Guards the "格式完整不是可信度信号"
  // discipline against authoritative-sounding worker reports.
  // Gated by RIVET_EXTERNAL_CLAIM_TRACKING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_EXTERNAL_CLAIM_TRACKING !== '0') {
    hooks.push(createExternalClaimTrackingHook({ advisoryBus: deps.advisoryBus }))
  }

  // General-Ledger（将星记账）: postTool hook — 带账本星 authority 的 delegate
  // 完成后，informational 提醒主控核对是否有新战绩该 record_general_finding。
  // 每星每会话最多一次；账本不存在的星不催账。
  // Gated by RIVET_GENERAL_LEDGER_REMINDER (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_GENERAL_LEDGER_REMINDER !== '0') {
    hooks.push(createGeneralLedgerHook({ advisoryBus: deps.advisoryBus }))
  }

  // Git-Clear-After-Fail: postTool hook — detects the pattern of running git
  // stash/reset/checkout/restore/clean shortly after a test failure without
  // any diagnosis (read/grep) in between. Constitutional tier: the underlying
  // action is irreversible and can harm other sessions in a shared worktree.
  // Gated by RIVET_GIT_CLEAR_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_GIT_CLEAR_GUARD !== '0') {
    hooks.push(createGitClearAfterFailHook({ advisoryBus: deps.advisoryBus }))
  }

  // Dead-End Detector: postTool hook — 同一文件反复 edit→verify-fail 循环
  // (≥2 次且无 verify pass)= 盲改死路。advisory 带 tool_appears 谓词
  // (采纳 = 转向诊断),触发时同步沉积文件级 dead-end 信息素。
  // Gated by RIVET_DEAD_END_DETECTOR (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_DEAD_END_DETECTOR !== '0') {
    hooks.push(createDeadEndDetectorHook({
      advisoryBus: deps.advisoryBus,
      deposit: deps.stigmergyDeposit,
    }))
  }

  // Batch Convergence: postTool hook — 单 turn 工具调用 ≥5 时触发收敛提醒，
  // 引导 agent 在汇总并行结果前进行分层收敛（分类→交叉验证→综合判断）。
  // 防止批量并行调用返回后信息过载导致误判。
  if (deps.advisoryBus) {
    hooks.push(createBatchConvergenceHook({ advisoryBus: deps.advisoryBus }))
  }

  // Regression-Bisect 断路器: postTool hook — 回归语义 + 连续 ≥5 轮只读诊断
  // 空转(零写入)时,强制策略升级到基线对照(git log → git bisect/checkpoint
  // diff → regressionInventory 逐项定位)。事故链缺口 4:20+ 轮盲排查救援。
  // Gated by RIVET_REGRESSION_BISECT (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_REGRESSION_BISECT !== '0') {
    hooks.push(createRegressionBisectHook({
      advisoryBus: deps.advisoryBus,
      getObjective: deps.getIntentObjective,
    }))
  }

  // Intent Anchor: preTurn hook — 长自治 run(>20 轮且距上次用户输入 >10 轮)
  // 重锚本次 run 的启动意图(taskContract?.objective ?? initialUserMessage)。
  // 无行为签名 → 无 expect,只计送达。冷却 10 轮。
  // Gated by RIVET_INTENT_ANCHOR (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getRunTurn && deps.getLastUserInputRunTurn && deps.getIntentObjective
    && process.env.RIVET_INTENT_ANCHOR !== '0') {
    hooks.push(createIntentAnchorHook({
      advisoryBus: deps.advisoryBus,
      getRunTurn: deps.getRunTurn,
      getLastUserInputTurn: deps.getLastUserInputRunTurn,
      getObjective: deps.getIntentObjective,
    }))
  }

  // Turn Budget: preTurn hook — maxTurns 预算进入危险区(剩余 ≤ max(3, 10%))
  // 时预警一次,引导收敛。expect = verify_attempted(采纳 = 先验证手头工作)。
  // Gated by RIVET_TURN_BUDGET_WARN (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getRunTurn && deps.getMaxTurns
    && process.env.RIVET_TURN_BUDGET_WARN !== '0') {
    hooks.push(createTurnBudgetHook({
      advisoryBus: deps.advisoryBus,
      getMaxTurns: deps.getMaxTurns,
      getRunTurn: deps.getRunTurn,
    }))
  }

  // Advisory-Readback: postTool 观察 + postTurn 核销 — 对送达的 advisory 按
  // expect 谓词判定 adopted/ignored，产出采纳率账本（P1a 生命周期闭环）。
  // 无独立开关：随 advisoryBus 存在自动启用（观察半边零副作用）。
  if (deps.advisoryBus && deps.advisoryReadback) {
    hooks.push(...createAdvisoryReadbackHooks({
      readback: deps.advisoryReadback,
      writeTelemetry: deps.telemetryWriter ? (r) => deps.telemetryWriter!.write(r) : undefined,
      onOutcomes: deps.onAdvisoryOutcomes,
    }))
  }

  // Virtue-Settlement: postTurn 效用核销 — 美德信号两段式
  // （stigmergy-hook 检测后 submit pending，此处 postTurn 核销效用后转正）。
  // 不需要 postTool 半边——advisory-readback-observe 已经在喂 readback 观察日志。
  if (deps.virtuePendingLedger && deps.advisoryReadback && deps.advisoryBus) {
    hooks.push(createVirtueSettlementHook({
      ledger: deps.virtuePendingLedger,
      readback: deps.advisoryReadback,
      recordStance: deps.recordStance ?? (() => {}),
      deposit: deps.stigmergyDeposit,
      advisoryBus: deps.advisoryBus,
      getSeason: () => deps.getCurrentSeason?.() ?? 'genesis',
      getSeasonIntensity: () => deps.getCurrentSeasonIntensity?.() ?? 1.0,
      getRecentCacheHitRate: () => deps.getRecentCacheHitRate?.() ?? null,
    }))
  }

  // Async-Copilot: postTurn hook — cheap-model 情境合成的中层建议（Phase 3）。
  // 可行性双闸门为运行时数据判定（全局采纳率 >30% 才激活）,自我淘汰降频。
  // Gated by RIVET_ASYNC_COPILOT (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.advisoryReadback && deps.asyncCopilot && process.env.RIVET_ASYNC_COPILOT !== '0') {
    const rb = deps.advisoryReadback
    hooks.push(createAsyncCopilotHook({
      advisoryBus: deps.advisoryBus,
      // 闸门 totals 含跨会话先验(贡献上限 20)——消灭"决出样本 ≥10"的每会话
      // 冷启动沉睡;自我淘汰的 per-key stats 保持会话实测。
      readback: { getTotals: () => rb.getTotalsWithPriors(), getStats: () => rb.getStats() },
      getContext: deps.asyncCopilot.getContext,
      complete: deps.asyncCopilot.complete,
      writeTelemetry: deps.telemetryWriter ? (r) => deps.telemetryWriter!.write(r) : undefined,
    }))
  }

  // Reasoning-Spiral Guard: preTurn hook — detects single-turn reasoning
  // spirals (3000+ chars thinking + zero tool calls). Session-scoped trend
  // tracking for escalation detection. Fills the gap that convergence-detector
  // and exploration-stall don't cover: pure thinking length without tools.
  // Gated by RIVET_REASONING_SPIRAL_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_REASONING_SPIRAL_GUARD !== '0') {
    hooks.push(createReasoningSpiralHook({ advisoryBus: deps.advisoryBus }))
  }

  // Language Anchor: postTool hook — when a turn's cumulative tool output is a
  // large, overwhelmingly non-CJK dump (code/log/search floods), re-anchor the
  // reasoning language via a short Chinese advisory. Counters training-mode
  // regression (English enumerative CoT) that star-signature alone cannot hold
  // against tens of KB of English (4e1aaa21 post-mortem).
  // Gated by RIVET_LANGUAGE_ANCHOR (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_LANGUAGE_ANCHOR !== '0') {
    hooks.push(createLanguageAnchorHook({ advisoryBus: deps.advisoryBus }))
  }

  // Context Pressure: afterPerception hook — warns when context window
  // fill ratio exceeds 70%, suggesting the agent wrap up and hand off to
  // a new session before the 86% split threshold triggers.
  if (deps.advisoryBus && deps.getEstimatedTokens && deps.getContextWindow) {
    hooks.push(createContextPressureHook({
      advisoryBus: deps.advisoryBus,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
    }))
  }

  // Gate-Block Guard: postTurn hook — 单 turn 被闸门拦截 ≥2 次时提醒
  // "被拦不是死路"，引导执行拦截文案里的替代路径而非放弃排查。
  // per-key 3 轮冷却防连拦 spam。
  // Gated by RIVET_GATE_BLOCK_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.drainGateBlockedKinds && process.env.RIVET_GATE_BLOCK_GUARD !== '0') {
    hooks.push(createGateBlockGuardHook({
      advisoryBus: deps.advisoryBus,
      drainBlockedKinds: deps.drainGateBlockedKinds,
    }))
  }

  // Wrapup-Anxiety Guard: postTurn hook — 收尾/新会话话术 × 实测 ctxRatio
  // 对照。ratio < 0.5 时注入硬数据反驳（焦虑话术不基于物理事实）；
  // 0.5-0.7 灰区不注入；≥0.7 不触发（context-pressure 的收束建议合法）。
  // Gated by RIVET_WRAPUP_ANXIETY_GUARD (default on; set to '0' to disable).
  if (deps.advisoryBus && deps.getStreamedText && deps.getEstimatedTokens && deps.getContextWindow
    && process.env.RIVET_WRAPUP_ANXIETY_GUARD !== '0') {
    hooks.push(createWrapupAnxietyGuardHook({
      advisoryBus: deps.advisoryBus,
      getStreamedText: deps.getStreamedText,
      getEstimatedTokens: deps.getEstimatedTokens,
      getContextWindow: deps.getContextWindow,
    }))
  }

  // Render-Verify: postTurn hook — UI 文件改动后未检查渲染结果时提醒。
  // 能力降级：browser/computer_use 未注册 → 提示人工过目。
  // 冷却：每会话 2 次。
  // Gated by RIVET_RENDER_VERIFY (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_RENDER_VERIFY !== '0') {
    hooks.push(createRenderVerifyHook({
      advisoryBus: deps.advisoryBus,
      getVisualToolsAvailable: deps.getVisualToolsAvailable,
    }))
  }

  // Spec-Verify Gate: preTurn hook — detects "read spec → implement
  // without verification" jumps and injects a constitutional advisory.
  if (deps.advisoryBus) {
    hooks.push(createSpecVerifyGateHook({ advisoryBus: deps.advisoryBus }))
  }

  // Typecheck-Reminder: postTurn hook — fills self-verify's blind spot. tsx
  // tests pass without type-checking, so "tests green" can hide a broken tsc.
  // Fires when TS files were edited + tests ran + no typecheck since.
  if (deps.advisoryBus) {
    hooks.push(createTypecheckReminderHook({ advisoryBus: deps.advisoryBus }))
  }

  // Todo-Reminder: postTurn hook — nudges the model to (a) create a todo list
  // when a multi-step task is running without one, and (b) refresh a stale list.
  // Soft by default, escalates wording when a long task still has no todo.
  if (deps.advisoryBus) {
    hooks.push(createTodoReminderHook({ advisoryBus: deps.advisoryBus, getTodos: deps.getTodos }))
  }

  // Background-jobs awareness — preTurn nudge while jobs run (requires bus + registry).
  if (deps.advisoryBus && deps.getJobs) {
    hooks.push(createBackgroundJobsHook({ advisoryBus: deps.advisoryBus, getJobs: deps.getJobs }))
  }

  if (deps.companionPresenceEnabled && deps.companionPresenceCwd && deps.sessionId) {
    hooks.push(createCompanionHeartbeatHook({
      cwd: deps.companionPresenceCwd,
      getSessionId: () => deps.sessionId,
      getDomainId: deps.getDomainId ?? (() => null),
      getCognitiveSnapshot: deps.getCognitiveSnapshot ?? (() => null),
      getObjective: deps.getObjective ?? (() => null),
    }))
  }

  if (deps.autoDelegate) {
    hooks.push(createDispatcherHook({ ...deps.autoDelegate, advisoryBus: deps.advisoryBus }))
  }

  if (deps.memoryLearning) {
    hooks.push(createMemoryLearningPostTurnHook(deps.memoryLearning))
  }

  if (deps.userHooksBridge) {
    hooks.push(...createUserHooksBridge(deps.userHooksBridge))
  }

  // Walkthrough recorder（付费版 v1 · T1）: postTool 捕获 computer_use 步骤，
  // postSession 组装走查工件。记录器恒开（无 computer_use 活动时零成本），
  // 回放查看器在桌面端 Pro gate。
  if (deps.walkthrough) {
    hooks.push(...createWalkthroughRecorderHooks(deps.walkthrough))
  }

  return hooks
}
