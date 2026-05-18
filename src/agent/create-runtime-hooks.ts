import type { RuntimeHook } from './runtime-hooks.js'
import { createPerceptionRuntimeHook } from './hooks/perception-hook.js'
import { createKickRuntimeHook } from './hooks/kick-hook.js'
import { createVigorAfterPerceptionHook, createVigorPostToolHook } from './hooks/vigor-hook.js'
import { createThetaRuntimeHook } from './hooks/theta-hook.js'
import { createStigmergyRuntimeHook } from './hooks/stigmergy-hook.js'
import { createSignalConsumerRuntimeHook } from './hooks/signal-consumer-hook.js'
import { createPlaybookReflectHook } from './hooks/playbook-reflect-hook.js'
import type { PlaybookStore } from './playbook-store.js'
import type { RetrospectInput } from './retrospect.js'
import type { DoomLoopLevel } from './trace-store.js'

export interface RuntimeHookDeps {
  stigmergyDeposit: (deposit: any) => Promise<void>
  stigmergyQuery: () => Promise<any>
  getEvidenceState: () => any
  setLoadedPheromones: (pheromones: any) => void
  getThetaState: () => any
  setThetaState: (state: any) => void
  getPredictionAccumulator: () => any
  playbookStore?: PlaybookStore
  buildRetrospectInput?: () => RetrospectInput
  getDoomLoopLevel?: () => DoomLoopLevel
}

export function createDefaultRuntimeHooks(deps: RuntimeHookDeps): RuntimeHook[] {
  const hooks: RuntimeHook[] = [
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

  if (deps.playbookStore && deps.buildRetrospectInput && deps.getDoomLoopLevel) {
    hooks.push(createPlaybookReflectHook({
      store: deps.playbookStore,
      buildRetrospectInput: deps.buildRetrospectInput,
      getDoomLoopLevel: deps.getDoomLoopLevel,
    }))
  }

  return hooks
}
