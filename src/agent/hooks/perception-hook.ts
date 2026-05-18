import type { PreTurnRuntimeHook } from '../runtime-hooks.js'
import { computeSensorium, computeStrategy } from '../sensorium.js'
import { applyProviderHealth } from '../perception.js'

export function createPerceptionRuntimeHook(): PreTurnRuntimeHook {
  return {
    phase: 'preTurn',
    name: 'perception-runtime',
    run(ctx) {
      if (!ctx.snapshot.sensoriumInput) return

      const baseSensorium = computeSensorium(ctx.snapshot.sensoriumInput)
      const sensorium = applyProviderHealth(
        baseSensorium,
        ctx.snapshot.providerDegradationRatio ?? 0,
      )
      const strategy = computeStrategy(sensorium)

      ctx.effects.setSensorium(sensorium)
      ctx.effects.setStrategy(strategy)
    },
  }
}
