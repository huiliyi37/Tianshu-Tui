import type { PostTurnRuntimeHook } from '../runtime-hooks.js'
import type { TelemetryWriter } from '../telemetry-writer.js'
import type { PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'

export interface PhysarumShadowTelemetryHookDeps {
  getStats: () => PhysarumShadowStats
  telemetryWriter: TelemetryWriter
}

/**
 * Pure B-arm telemetry for Physarum shadow prediction quality.
 * Semantics: hit rates are next-step only — each prediction is judged against
 * the immediately next distinct file access, not a later window hit.
 */
export function createPhysarumShadowTelemetryHook(deps: PhysarumShadowTelemetryHookDeps): PostTurnRuntimeHook {
  return {
    phase: 'postTurn',
    name: 'physarum-shadow-telemetry',
    run(ctx) {
      const stats = deps.getStats()
      if (stats.total === 0) return

      deps.telemetryWriter.write({
        ts: Date.now(),
        turn: ctx.snapshot.turn,
        phase: 'physarum-shadow-stats',
        semantic: stats.semantic,
        total: stats.total,
        hit1: stats.hit1,
        hit3: stats.hit3,
        miss: stats.miss,
        hitAt1: stats.hitAt1,
        hitAt3: stats.hitAt3,
      } as any)
    },
  }
}
