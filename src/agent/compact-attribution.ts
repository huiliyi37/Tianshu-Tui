/**
 * Compact attribution — turn-boundary observability for context compaction.
 *
 * When a turn's message history shrinks (compact / partial compact / session
 * split / stale-round / heap micro-compact), we want two questions answerable
 * from the cache-log alone, without reaching into compaction-controller internals:
 *
 *   1. Was the rewrite NECESSARY?  → compactPreRatio (the window fill ratio just
 *      before the rewrite). A low pre-ratio with a rewrite is a candidate
 *      wasteful prefix-cache break.
 *   2. What did it COST and BUY?   → the turn's own hitRate (recorded separately)
 *      is the cache cost; compactReclaimed is the tokens it freed.
 *
 * preRatio is derived from the previous turn's estimated size, so it slightly
 * undercounts (it misses the latest user message added before this turn's
 * compaction). That is acceptable for a "was the window under pressure" signal.
 */

/** Below this fill ratio, a history rewrite likely broke the prefix cache for headroom that was not yet needed. */
export const LOW_PRESSURE_REWRITE_RATIO = 0.5

export interface CompactAttribution {
  /** Estimated tokens before the rewrite (previous turn's size). Omitted on the first turn. */
  compactTokensBefore?: number
  /** Estimated tokens after the rewrite (this turn's size). */
  compactTokensAfter: number
  /** Tokens freed by the rewrite (before − after, clamped at 0). Omitted on the first turn. */
  compactReclaimed?: number
  /** Window fill ratio just before the rewrite, rounded to 3 decimals. Omitted on the first turn or unknown window. */
  compactPreRatio?: number
  /** Id of the compact-history artifact this rewrite produced, when the dropped
   *  zone was archived (layered archival). Lets analyze-compact-events correlate
   *  a rewrite turn with the recall telemetry by artifact id — i.e. "was the
   *  dropped content ever recalled?". Omitted when nothing was archived. */
  archiveId?: string
}

export function computeCompactAttribution(
  prevEstTokens: number,
  estTokensNow: number,
  contextWindow: number,
): CompactAttribution {
  const attr: CompactAttribution = { compactTokensAfter: estTokensNow }
  if (prevEstTokens > 0) {
    attr.compactTokensBefore = prevEstTokens
    attr.compactReclaimed = Math.max(0, prevEstTokens - estTokensNow)
    if (contextWindow > 0) {
      attr.compactPreRatio = Math.round((prevEstTokens / contextWindow) * 1000) / 1000
    }
  }
  return attr
}

/** True when a rewrite happened while the window was below the low-pressure ratio — a likely-unnecessary cache break. */
export function isLowPressureRewrite(preRatio: number | undefined): boolean {
  return preRatio !== undefined && preRatio < LOW_PRESSURE_REWRITE_RATIO
}
