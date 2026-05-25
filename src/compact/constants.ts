import type { CacheType, ProviderProfile } from '../api/provider-profile.js'

/**
 * Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+),
 * then generalized by ACF into provider-aware ratios.
 */

/** Auto compaction trigger: 80% of 1M context window */
export const AUTO_COMPACT_THRESHOLD = 800_000

/** Hard floor: never auto-compact below this token count */
export const MINIMUM_AUTO_COMPACT_TOKENS = 500_000

export interface CompactThresholds {
  autoThreshold: number
  autoFloor: number
  toolResultMaxTokens: number
}

export type CompactProviderStrategy = 'cache-preserving' | 'balanced' | 'aggressive'

export interface CompactStrategyInput {
  contextWindow: number
  providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent' | 'ttlSeconds'>
}

export interface CompactPolicyRatios {
  watch: number
  compact: number
  reactive: number
  ceiling: number
}

const DEFAULT_POLICY_RATIOS: CompactPolicyRatios = {
  watch: 0.6,
  compact: 0.78,
  reactive: 0.88,
  ceiling: 0.95,
}

const STRATEGY_POLICY_RATIOS: Record<CompactProviderStrategy, CompactPolicyRatios> = {
  // DeepSeek-style persistent exact-prefix cache: compaction is expensive because
  // reshaping history can invalidate a valuable prefix. Delay non-emergency
  // compaction while retaining the 95% hard ceiling.
  'cache-preserving': { watch: 0.72, compact: 0.86, reactive: 0.92, ceiling: 0.95 },
  // OpenAI/Gemini/Claude-like cache paths: some cache survives or TTL is short,
  // so keep the existing ACF behaviour.
  balanced: DEFAULT_POLICY_RATIOS,
  // MiMO/local/no-cache providers: no prefix-cache loss, so compact earlier to
  // keep the active context cleaner.
  aggressive: { watch: 0.5, compact: 0.7, reactive: 0.84, ceiling: 0.95 },
}

function strategyForCacheType(cacheType: CacheType, persistent: boolean): CompactProviderStrategy {
  if (cacheType === 'exact-prefix' && persistent) return 'cache-preserving'
  if (cacheType === 'none') return 'aggressive'
  return 'balanced'
}

export function compactProviderStrategy(providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>): CompactProviderStrategy {
  if (!providerProfile) return 'balanced'
  return strategyForCacheType(providerProfile.cacheType, providerProfile.persistent)
}

export function compactPolicyRatios(providerProfile?: Pick<ProviderProfile, 'cacheType' | 'persistent'>): CompactPolicyRatios {
  return STRATEGY_POLICY_RATIOS[compactProviderStrategy(providerProfile)]
}

export function compactThresholds(input: number | CompactStrategyInput): CompactThresholds {
  const contextWindow = typeof input === 'number' ? input : input.contextWindow
  const ratios = typeof input === 'number'
    ? { watch: 0.6, compact: 0.78, reactive: 0.8, ceiling: 0.95 }
    : compactPolicyRatios(input.providerProfile)
  const isLargeWindow = contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS
  const toolResultHardCap = isLargeWindow ? 200_000 : 100_000

  return {
    autoThreshold: Math.floor(contextWindow * ratios.reactive),
    autoFloor: Math.min(Math.floor(contextWindow * ratios.watch), MINIMUM_AUTO_COMPACT_TOKENS),
    toolResultMaxTokens: Math.min(Math.floor(contextWindow * 0.3), toolResultHardCap),
  }
}

/** Number of messages to preserve at the start as cache anchor.
 * Keeping the first 2 messages (initial user request + assistant response)
 * preserves the prefix structure after compaction, so DeepSeek's prefix
 * cache can still match [System][Tools][Volatile][User1][Asst1]. */
export const CACHE_ANCHOR_MESSAGES = 2

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

/**
 * Adaptive compact ratios: shift base strategy thresholds based on observed cache hit rate.
 * - High hit rate → delay compaction (protect valuable prefix cache)
 * - Low hit rate → compact freely (cache already broken, nothing to protect)
 */
export function adaptiveCompactPolicyRatios(
  providerProfile: Pick<ProviderProfile, 'cacheType' | 'persistent'> | undefined,
  recentHitRate: number | null,
): CompactPolicyRatios {
  const base = compactPolicyRatios(providerProfile)
  if (recentHitRate === null) return base

  if (recentHitRate >= 0.85) {
    return {
      watch: Math.min(base.watch + 0.05, 0.90),
      compact: Math.min(base.compact + 0.03, 0.93),
      reactive: Math.min(base.reactive + 0.02, 0.95),
      ceiling: base.ceiling,
    }
  }
  if (recentHitRate < 0.3) {
    return {
      watch: Math.max(base.watch - 0.10, 0.40),
      compact: Math.max(base.compact - 0.08, 0.60),
      reactive: Math.max(base.reactive - 0.05, 0.75),
      ceiling: base.ceiling,
    }
  }
  return base
}

/** Prune: number of recent messages to protect from clearing.
 * Legacy default for small (<200K) windows. Use `pruneThresholds(contextWindow)`
 * for window-aware values; this constant is retained as the fallback. */
export const PRUNE_PROTECT_RECENT_MESSAGES = 8

/** Prune: minimum content length to bother clearing (shorter results cost little).
 * Legacy default for small windows; see `pruneThresholds`. */
export const PRUNE_MIN_CONTENT_CHARS = 1_200

export interface PruneThresholds {
  protectRecent: number
  minChars: number
}

/**
 * Window-aware prune thresholds.
 *
 * The legacy 8-message / 1.2KB defaults date back to the 64K-window era. On a
 * 1M window they fire after only 4–5 turns and replace ~60KB tool_results
 * (e.g. a single read_file) with `[pruned: …]` placeholders. The model loses
 * the content it just read and falls back to "split into temp files" workarounds
 * trained for truncated contexts.
 *
 * We scale up so prune only kicks in when there is real pressure, not after
 * every 4 turns.
 */
export function pruneThresholds(contextWindow: number): PruneThresholds {
  if (contextWindow >= 500_000) {
    // 500K–1M+: protect ~30 turns and only clear genuinely huge tool_results.
    // 150K = ~4% of a 1M window in chars; below that prune is a net loss
    // (we delete the model's working memory to save context it isn't using).
    // A typical large source file (loop.ts ~62K, README ~30K) stays untouched
    // for the entire session. Same threshold gates artifact wrapping in
    // read_file/bash/grep — content under this size is returned as plain text,
    // no artifact reference.
    return { protectRecent: 60, minChars: 150_000 }
  }
  if (contextWindow >= 200_000) {
    return { protectRecent: 30, minChars: 40_000 }
  }
  // <200K: keep the legacy aggressive behaviour — small windows really do
  // need prune to fire early.
  return { protectRecent: PRUNE_PROTECT_RECENT_MESSAGES, minChars: PRUNE_MIN_CONTENT_CHARS }
}

/** Stale-round compaction (truncate tool messages in N-2+ rounds): same scaling
 * as prune so the two layers stay coherent. Stale-round runs *after* prune and
 * truncates rather than fully replacing, so it tolerates more aggressive
 * settings than prune. */
export interface StaleRoundThresholds {
  recentToKeep: number
  previewChars: number
}

export function staleRoundThresholds(contextWindow: number): StaleRoundThresholds {
  if (contextWindow >= 500_000) {
    // Match pruneThresholds.minChars at 1M — stale-round runs after prune
    // so we want them coherent. 150K preview means a 200K read_file gets
    // truncated to its leading 150K (still 75% of original), not chopped to
    // 30K head + tail.
    return { recentToKeep: 30, previewChars: 150_000 }
  }
  if (contextWindow >= 200_000) {
    return { recentToKeep: 12, previewChars: 40_000 }
  }
  return { recentToKeep: 4, previewChars: 1_200 }
}

/** Per-message aggregate budget: max total chars across all tool results in one turn.
 *
 * Legacy static value kept for back-compat. New callers should prefer
 * {@link perMessageToolResultBudget} which scales with contextWindow. */
export const PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS = 120_000

/**
 * Window-aware per-message tool result budget.
 *
 * Formula: `min(pruneThresholds(contextWindow).minChars × 2, 300_000)`
 *
 * Why ×2? A single turn may contain multiple tool results. If the L0/L1
 * artifact threshold (minChars) says "content under X stays inline," then
 * the per-message budget for ALL inline tool results in one turn should be
 * at least 2× that — allowing one large + several small results.
 *
 * Why cap at 300_000? The absolute max for a single tool result is
 * ABSOLUTE_MAX_CHARS (200_000) from model-read-cap. Doubling that (400_000)
 * risks filling ~40% of a 1M window with tool results alone. 300_000 is a
 * safer ceiling.
 *
 * Why floor at legacy 120_000? For small windows where ×2 minChars would
 * actually be lower (e.g. 64K window → minChars=1200 → ×2=2400), we keep
 * the legacy constant which was already conservative at ~50% of a 64K window.
 */
export function perMessageToolResultBudget(contextWindow: number): number {
  if (!contextWindow || contextWindow <= 0) {
    return PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS
  }
  const { minChars } = pruneThresholds(contextWindow)
  const scaled = minChars * 2
  if (scaled < PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS) {
    return PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS
  }
  return Math.min(scaled, 300_000)
}

/**
 * Maximum characters of a tool result content to keep inline in SessionContext.oaiMessages.
 * Results exceeding this are truncated in memory (full content remains on disk via artifact).
 *
 * 50KB ~= 0.005% of a 1M window, or ~12.5K tokens. Large enough for the model to get
 * meaningful context from recent results, small enough to bound per-message memory.
 *
 * This is a memory-safety constraint, distinct from the cache-oriented prune thresholds.
 * Prune thresholds control what the API sees; this constant controls what stays in JS heap.
 */
export const INLINE_TOOL_RESULT_MAX_CHARS = 50_000
