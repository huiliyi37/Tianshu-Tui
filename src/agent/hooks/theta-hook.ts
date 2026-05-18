import type { PostToolRuntimeHook } from '../runtime-hooks.js'
import { advanceThetaCounter, completeTheta, tickTheta } from '../star-event.js'
import type { ThetaState } from '../star-event.js'

export interface ThetaRuntimeHookDeps {
  getThetaState: () => ThetaState
  setThetaState: (state: ThetaState) => void
}

export function createThetaRuntimeHook(deps: ThetaRuntimeHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'theta-runtime',
    run(ctx) {
      const advanced = advanceThetaCounter(deps.getThetaState())
      deps.setThetaState(advanced)

      const sensorium = ctx.snapshot.sensorium
      if (!sensorium || sensorium.complexity <= 0.5) return
      if (!tickTheta(advanced, ctx.snapshot.turn)) return

      ctx.effects.requestThetaCheck('theta-cycle')
      deps.setThetaState(completeTheta(advanced))
    },
  }
}
