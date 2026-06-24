import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
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
import { createTypecheckReminderHook } from './hooks/typecheck-reminder-hook.js'
import { createEditToolAdvisoryHook } from './hooks/edit-tool-advisory-hook.js'
import { createLossyObservationHook } from './hooks/lossy-observation-hook.js'
import { createContextPressureHook } from './hooks/context-pressure-hook.js'
import { createSpecVerifyGateHook } from './hooks/spec-verify-gate-hook.js'
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
  getCognitiveSnapshot?: () => { vigor: number; stability: number; season: string } | null
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
  /** CCR telemetry callback — invoked on each capsule router trigger for offline analysis. */
  onCcrTrigger?: (event: CcrTriggerEvent) => void
  /** Sycophancy trap — courage-hook consumes its cumulative state for constitutional override */
  sycophancyTrap?: import('./sycophancy-trap.js').SycophancyTrap

  // ── Context pressure advisory ──
  /** Estimated token count (used by context-pressure-hook for ratio warning). */
  getEstimatedTokens?: () => number
  /** Context window size (used by context-pressure-hook for ratio warning). */
  getContextWindow?: () => number

  // ── P2 break-anchor scout (preTurn, opt-in real intervention) ──
  /** Present only when antiAnchoring + anchorBreakScout are both enabled and a coordinator exists. */
  anchorBreakScout?: {
    config: AnchorBreakScoutConfig
    getCoordinator: () => DelegationCoordinator | null
    getAbortSignal?: () => AbortSignal | undefined
  }
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
    createKickRuntimeHook({ deposit: deps.stigmergyDeposit, wasConvergenceTriggered: deps.wasConvergenceTriggered, advisoryBus: deps.advisoryBus }),
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
    hooks.push(createSelfVerifyHook({ advisoryBus: deps.advisoryBus }))
  }

  // Edit-Tool Advisory: postTool hook — detects consecutive hash_edit calls
  // on the same file (the #1 cause of bracket-mismatch debris). Uses a
  // turn-scoped Map to avoid the 5-entry recentToolHistory window limit.
  // Gated by RIVET_EDIT_SMART_ROUTING (default on; set to '0' to disable).
  if (deps.advisoryBus && process.env.RIVET_EDIT_SMART_ROUTING !== '0') {
    hooks.push(createEditToolAdvisoryHook({ advisoryBus: deps.advisoryBus }))
  }

  // Lossy Observation: postTool hook — detects collapsed/truncated tool
  // output and reinforces the discipline that lossy observations cannot
  // support negative conclusions. Complements guardLossyToolResult's
  // inline VERIFICATION_REQUIRED marker (which only fires on lossy + negative).
  if (deps.advisoryBus) {
    hooks.push(createLossyObservationHook({ advisoryBus: deps.advisoryBus }))
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

  return hooks
}
