import type { PostToolRuntimeHook, RuntimeHookContext, RuntimeToolEvent } from '../runtime-hooks.js'
import type { AdvisoryBus } from '../advisory-bus.js'

/**
 * Language Anchor Hook — postTool detection of large non-CJK content dumps
 * that dilute the model's Chinese persona anchors.
 *
 * Background (4e1aaa21 post-mortem, 2026-07-02): a single 50KB English source
 * dump flipped GLM's reasoning language to English and unlocked the RL
 * "training-mode" style — exhaustive enumerative CoT that runs for minutes.
 * The star-signature countermeasure (思路 E, a few Chinese tokens appended to
 * each tool result) is diluted to irrelevance against tens of KB of English.
 * This hook covers the high-dosage case: when a turn's cumulative tool output
 * is overwhelmingly non-CJK, re-anchor via a short Chinese system-reminder.
 *
 * Complements star-signature: signature = per-result token-level anchor;
 * this hook = per-turn dosage-level anchor. Neither touches frozenBase or
 * the volatile block — the advisory travels through the AdvisoryBus's
 * system-reminder channel, prefix-cache safe.
 *
 * Tier: key='language-anchor', category='discipline', priority=0.52 —
 * above lossy-observation (0.48) / edit-tool-advisory (0.5): identity drift
 * compounds (English reasoning self-reinforces), so it must not be crowded out.
 *
 * Cooldown: at most 1 advisory per turn; accumulator resets on turn change.
 */

export interface LanguageAnchorHookDeps {
  advisoryBus: Pick<AdvisoryBus, 'submit'>
  /** Cumulative non-CJK-dominated chars in one turn before firing. Default 15000. */
  thresholdChars?: number
  /** CJK char ratio at or above which content is considered anchored. Default 0.05. */
  cjkRatioFloor?: number
}

const DEFAULT_THRESHOLD_CHARS = 15_000
const DEFAULT_CJK_RATIO_FLOOR = 0.05

/** CJK Unified Ideographs + extension A, CJK punctuation, fullwidth forms. */
const CJK_RE = /[\u3400-\u4dbf\u4e00-\u9fff\u3000-\u303f\uff00-\uffef]/g

export function countCjkChars(text: string): number {
  return text.match(CJK_RE)?.length ?? 0
}

const ADVISORY_CONTENT =
  '【天枢】语言锚定：本轮已注入大量非中文内容（代码/日志/搜索结果）。'
  + '继续用中文推理与作答；保持结论先行、要点收敛，'
  + '不要滑入英文长链穷举模式（逐场景枚举、反复自问自答）。'
  + '已有信息足够时直接回答，不再追加探索。'

export function createLanguageAnchorHook(deps: LanguageAnchorHookDeps): PostToolRuntimeHook {
  const thresholdChars = deps.thresholdChars ?? DEFAULT_THRESHOLD_CHARS
  const cjkRatioFloor = deps.cjkRatioFloor ?? DEFAULT_CJK_RATIO_FLOOR

  let trackedTurn = -1
  let totalChars = 0
  let cjkChars = 0
  let firedThisTurn = false

  return {
    phase: 'postTool',
    name: 'language-anchor',
    run(ctx: RuntimeHookContext, tool: RuntimeToolEvent): void {
      const turn = ctx.snapshot.turn
      if (turn !== trackedTurn) {
        trackedTurn = turn
        totalChars = 0
        cjkChars = 0
        firedThisTurn = false
      }
      if (firedThisTurn) return

      const content = tool.resultContent
      if (!content) return

      totalChars += content.length
      cjkChars += countCjkChars(content)

      if (totalChars < thresholdChars) return
      if (cjkChars / totalChars >= cjkRatioFloor) return

      firedThisTurn = true
      deps.advisoryBus.submit({
        key: 'language-anchor',
        priority: 0.52,
        category: 'discipline',
        content: ADVISORY_CONTENT,
        ttl: 1,
      })
    },
  }
}
