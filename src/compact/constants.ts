/**
 * Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+).
 *
 * DeepSeek V4 has a 1M context window. Auto compaction triggers at 80%
 * (800K tokens) with a hard floor of 500K to avoid destroying a healthy
 * prefix cache.
 */

/** Auto compaction trigger: 80% of 1M context window */
export const AUTO_COMPACT_THRESHOLD = 800_000

/** Hard floor: never auto-compact below this token count */
export const MINIMUM_AUTO_COMPACT_TOKENS = 500_000

/** Number of most recent messages to keep during micro-compact */
export const KEEP_RECENT_MESSAGES = 4

/** Minimum number of messages before summarizing (avoid summary of nothing) */
export const MIN_SUMMARIZE_MESSAGES = 6

/** Character limits for summary input sent to compaction model */
export const SUMMARY_INPUT_MAX_CHARS = 24_000
export const SUMMARY_INPUT_HEAD_CHARS = 14_000
export const SUMMARY_INPUT_TAIL_CHARS = 6_000

/** Large context (500K+) summary limits */
export const LARGE_CONTEXT_WINDOW_TOKENS = 500_000
export const LARGE_CONTEXT_SUMMARY_INPUT_MAX_CHARS = 120_000
export const LARGE_CONTEXT_SUMMARY_INPUT_HEAD_CHARS = 72_000
export const LARGE_CONTEXT_SUMMARY_INPUT_TAIL_CHARS = 36_000
export const LARGE_CONTEXT_SUMMARY_MAX_TOKENS = 2_048

/** Cache-aligned summary keeps 85% of context budget */
export const CACHE_ALIGNED_BUDGET_PERCENT = 85

/** Maximum output tokens for compaction summary (used when calling compaction model in future integration) */
// TODO: Wire into auto-compact API call when integrating LLM-based compaction
export const COMPACTION_SUMMARY_MAX_TOKENS = 1_024

export interface CompactionConfig {
  enabled: boolean
  autoThreshold: number
  autoFloor: number
  model: string
}
