import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
import { createSignalConsumerRuntimeHook } from './hooks/signal-consumer-hook.js'

export interface RuntimeHookDeps {
  stigmergyDeposit: (deposit: any) => Promise<void>
  stigmergyQuery: () => Promise<any>
  getEvidenceState: () => any
  setLoadedPheromones: (pheromones: any) => void
  getThetaState: () => any
  setThetaState: (state: any) => void
  getPredictionAccumulator: () => any
}

export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  return [
    createPerceptionRuntimeHook(),
    createSignalConsumerRuntimeHook(),
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
  ]
}
