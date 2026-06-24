import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Lossy Observation Hook — postTool detection of collapsed/truncated tool
 * results, reinforcing the rule that lossy observations cannot support
 * negative conclusions.
 *
 * Coordination with negative-fact-detector:
 *   - `guardLossyToolResult` (tool-execution.ts) injects inline
 *     [⚠ VERIFICATION_REQUIRED] markers when lossy output ALSO contains
 *     negative claims — this is corrective.
 *   - This hook fires on ANY lossy output — reminding the model about the
 *     general discipline before it can form a negative conclusion. This is
 *     preventive.
 *
 * Tier: key='lossy-observation', category='discipline', priority=0.48.
 * Deliberately lower than edit-tool-advisory (0.5) and discipline-reanchor
 * (0.55) — lossy markers are routine and shouldn't crowd out higher-signal
 * advisories.
 *
 * Cooldown: at most 1 advisory per turn, even if multiple lossy tools fire.
 */

export interface LossyObservationHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
}

/** Patterns matching lossy observation markers (synced with negative-fact-detector.ts). */
const LOSSY_CONTENT_MARKERS = [
  /^\[storm-collapsed:/,
  /^\[tiered-summary:/,
  /^\[collapsed /,
  /\[output truncated:/,
  /\[stdout truncated:/,
  /\[stderr truncated:/,
]

const ADVISORY_CONTENT =
  '【天枢】有损观测：上一个工具输出被折叠/截断。禁止从中推出负向结论（"不存在""为空""0 results"等）——用 find / glob / git status 独立交叉验证后再下断言。'

export function createLossyObservationHook(deps: LossyObservationHookDeps): PostToolRuntimeHook {
  let lastFiredTurn = -1

  return {
    phase: 'postTool',
    name: 'lossy-observation',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      // At most 1 advisory per turn
      if (ctx.snapshot.turn === lastFiredTurn) return

      const content = tool.resultContent
      if (!content) return

      let isLossy = false
      for (const marker of LOSSY_CONTENT_MARKERS) {
        if (marker.test(content)) {
          isLossy = true
          break
        }
      }
      if (!isLossy) return

      lastFiredTurn = ctx.snapshot.turn
      deps.advisoryBus.submit({
        key: 'lossy-observation',
        priority: 0.48,
        category: 'discipline',
        content: ADVISORY_CONTENT,
        ttl: 1,
      })
    },
  }
}
