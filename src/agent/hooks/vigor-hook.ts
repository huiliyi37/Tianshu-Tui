import type { AfterPerceptionRuntimeHook, PostToolRuntimeHook } from '../runtime-hooks.js'
import type { PredictionAccumulator } from '../prediction-error.js'
import {
  createVigorState,
  modulateStrategyByVigor,
  shouldTriggerElmRelease,
  updateVigor,
} from '../vigor.js'

export interface VigorPostToolHookDeps {
  getPredictionAccumulator: () => PredictionAccumulator
}

export function createVigorPostToolHook(deps: VigorPostToolHookDeps): PostToolRuntimeHook {
  return {
    phase: 'postTool',
    name: 'vigor-post-tool',
    run(ctx, tool) {
      const sensorium = ctx.snapshot.sensorium
      if (!sensorium) return

      const prev = ctx.snapshot.vigor ?? createVigorState()
      const next = updateVigor(prev, {
        toolSuccess: tool.success,
        sensorium,
        predictionAcc: deps.getPredictionAccumulator(),
        // Pass failure class so vigor can distinguish semantic failures
        // (type_error, assertion → full penalty) from environment issues
        // (timeout, api_error → reduced penalty).
        failureClass: tool.failureClass,
      })

      ctx.effects.setVigor(next)
    },
  }
}

export function createVigorAfterPerceptionHook(): AfterPerceptionRuntimeHook {
  return {
    phase: 'afterPerception',
    name: 'vigor-after-perception',
    run(ctx) {
      const { sensorium, strategy, vigor } = ctx.snapshot
      if (!sensorium || !strategy || !vigor) return

      const adjusted = modulateStrategyByVigor(strategy, vigor, sensorium)
      ctx.effects.setStrategy(adjusted)

      if (shouldTriggerElmRelease(vigor)) {
        // Suppress elm-micro-release if recent theta checks timed out —
        // spawning more checks won't help if tsc is unresponsive.
        const theta = ctx.snapshot.thetaTelemetry
        if (!theta || !theta.lastTimedOut) {
          ctx.effects.requestThetaCheck('elm-micro-release')
        }
      }
    },
  }
}
