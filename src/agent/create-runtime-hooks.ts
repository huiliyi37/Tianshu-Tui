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
import { isStarSoulEnabled } from './star-soul-gate.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput } from './retrospect.js'
import type { DoomLoopLevel } from './trace-store.js'
import type { TelemetryWriter } from './telemetry-writer.js'
import type { EvidenceState } from './evidence.js'
import type { TrajectoryEntry } from './trajectory.js'
import type { DomainVoiceId } from './domain-voice.js'

export interface RuntimeHookDeps {
  stigmergyDeposit: (deposit: any) => Promise<void>
  stigmergyQuery: () => Promise<any>
  getEvidenceState: () => EvidenceState
  setLoadedPheromones: (pheromones: any) => void
  getThetaState: () => any
  setThetaState: (state: any) => void
  getPredictionAccumulator: () => any
  telemetryWriter?: TelemetryWriter
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
    }),
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

  return hooks
}
