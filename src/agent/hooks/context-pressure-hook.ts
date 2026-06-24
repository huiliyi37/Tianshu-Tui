import type { AfterPerceptionRuntimeHook, RuntimeHookContext } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Context Pressure Hook — afterPerception advisory when context window
 * fill ratio exceeds a warning threshold.
 *
 * Suggests offloading remaining work to a new session before hitting the
 * 86% split threshold (CompactBoundaryCoordinator.trySessionSplit).
 *
 * Tier: key='context-pressure', category='cerebellar', priority=0.5.
 * One advisory per turn max. Suppressed when ratio drops back below threshold.
 */

export interface ContextPressureHookDeps {
  getEstimatedTokens: () => number
  getContextWindow: () => number
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Ratio above which the advisory fires. Below 86% split but high enough
 *  to give the agent time to wrap up. */
const PRESSURE_WARN_RATIO = 0.7

export function createContextPressureHook(deps: ContextPressureHookDeps): AfterPerceptionRuntimeHook {
  let lastFiredTurn = -1

  return {
    phase: 'afterPerception',
    name: 'context-pressure',
    run(ctx: RuntimeHookContext): void {
      // Once per turn max
      if (ctx.snapshot.turn === lastFiredTurn) return

      const estimated = deps.getEstimatedTokens()
      const window = deps.getContextWindow()
      if (window <= 0 || estimated <= 0) return

      const ratio = estimated / window
      if (ratio < PRESSURE_WARN_RATIO) return

      lastFiredTurn = ctx.snapshot.turn
      deps.advisoryBus.submit({
        key: 'context-pressure',
        priority: 0.5,
        category: 'cerebellar',
        content: `上下文窗口使用率 ${Math.round(ratio * 100)}%（${estimated}/${window} tokens）。接近上限时 compact-boundary 会自动分拆会话，但建议你主动收束当前子任务、把后续工作留给新会话。`,
        ttl: 1,
      })
    },
  }
}
