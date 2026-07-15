import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'
import { isLossyObservation } from '../lossy-markers.js'

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

      // W1-A4: marker list is the shared module (lossy-markers.ts) — single
      // source of truth with negative-fact-detector.
      if (!isLossyObservation(content)) return

      lastFiredTurn = ctx.snapshot.turn
      // W3-C2 expect 审计：建议的交叉验证工具（glob/grep/bash）在正常流程中
      // 几乎每轮都会出现——“工具出现”无法区分“因提醒而验证”与“本来就要用”。
      // 这是计划明确禁止的过宽伪 expect，刻意不填。
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
