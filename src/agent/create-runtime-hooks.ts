import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
import { createSignalConsumerRuntimeHook } from './hooks/signal-consumer-hook.js'
import { createPlaybookReflectHook } from './hooks/playbook-reflect-hook.js'
import { createTelemetryFlushHook } from './hooks/telemetry-flush-hook.js'
import { createDreamHook } from './hooks/dream-hook.js'
import { createCourageHook } from './hooks/courage-hook.js'
import { createRadioHook, type RadioHookDeps } from './hooks/radio-hook.js'
import { createConsistencyCheckHook } from './hooks/consistency-check-hook.js'
import { createMeridianHook, type MeridianHookDeps } from './hooks/meridian-hook.js'
import { createSonglineRuntimeHook } from './hooks/songline-hook.js'
import { createHearthObserveHook } from './hooks/hearth-observe-hook.js'
import type { AnchorGraph } from '../prompt/anchor-graph.js'
import { isStarSoulEnabled } from './star-soul-gate.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput } from './retrospect.js'
import type { DoomLoopLevel } from './trace-store.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import type { EvidenceState } from './evidence.js'
import type { TaskLedgerSummary } from './task-ledger.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { DomainVoiceId } from './domain-voice.js'
import type { ContextClaim } from '../context/claims.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

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
  /** Publish cross-session event (file changes, type errors, etc.) */
  publishEvent?: (input: { eventType: string; filePath?: string; detail?: string; priority?: number }) => void
  /** Current session ID for event attribution */
  sessionId?: string
  dream?: {
    cwd: string
    sessionId: string
    getDecisions: () => string[]
    getTrajectory: () => TrajectoryEntry[]
  }
  playbookStore?: PlaybookStore
  buildRetrospectInput?: () => RetrospectInput
  getDoomLoopLevel?: () => DoomLoopLevel
  chronicle?: { addRadio: (message: string, turn: number) => void; addPhaseTransition: (input: { fromPhase: string; toPhase: string; turn: number; summary: string }) => void }
  /** Returns current star domain id for radio voice modulation. null when no domain matched. */
  getDomainId?: () => DomainVoiceId
  /** File observation claims for cross-store consistency checks. */
  getFileObservations?: () => Array<Pick<ContextClaim, 'id' | 'text' | 'evidence'>>
  /** Meridian code graph indexer (optional). */
  meridianIndexer?: MeridianIndexer | null
  /** Explicit opt-in for Songline substrate post-session deposit. Default: false. */
  songlineEnabled?: boolean
  /** Task summary source for Songline substrate. Required only when songlineEnabled is true. */
  getTaskSummary?: () => TaskLedgerSummary | null
  /** Optional cycle relay bridge for Songline substrate. */
  setCycleClose?: (sessionId: string, closeHash: string) => void

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
}

export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  const hooks: RuntimeHook[] = [
    createPerceptionRuntimeHook(),
    createSignalConsumerRuntimeHook(),
    ...(isStarSoulEnabled() ? [createCourageHook({ cooldownTurns: 5, courageThreshold: 0.5 })] : []),
    createKickRuntimeHook({ deposit: deps.stigmergyDeposit }),
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
    }))
  }

  if (deps.dream) {
    hooks.push(createDreamHook({
      cwd: deps.dream.cwd,
      sessionId: deps.dream.sessionId,
      getEvidenceState: deps.getEvidenceState,
      getDecisions: deps.dream.getDecisions,
      getTrajectory: deps.dream.getTrajectory,
    }))
  }

  if (deps.telemetryWriter) {
    hooks.push(createTelemetryFlushHook(deps.telemetryWriter))
  }

  if (deps.meridianIndexer !== undefined) {
    const indexerRef = deps.meridianIndexer
    hooks.push(createMeridianHook({ getIndexer: () => indexerRef }))
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

  return hooks
}
