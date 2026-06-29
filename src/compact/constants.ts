import type { CacheType, ProviderProfile } from '../api/provider-profile.js'

/**
 * Compaction constants ported from DeepSeek TUI compaction.rs (v0.8.11+),
 * then generalized by ACF into provider-aware ratios.
 */

/**
 * @deprecated Legacy static trigger, superseded by the ratio-based policy
 * (`compactPolicyRatios` + `decideCompactTier`). Kept only because the config
 * schema (`compact.autoThreshold`) still defaults to it — runtime compaction
 * decisions never read this value. Do not add new consumers.
 */
export const AUTO_COMPACT_THRESHOLD = 800_000

/**
 * @deprecated Legacy static floor, superseded by the ratio-based policy.
 * Kept only for the config schema default (`compact.autoFloor`). The previous
 * `Math.min(watch, 500K)` clamp in `compactThresholds` inverted the intended
 * "never compact below" semantics on 1M windows (lowering 720K watch to 500K)
 * and has been removed. Do not add new consumers.
 */
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
    // Pure ratio — the old Math.min(..., 500K) clamp dragged the 1M
    // cache-preserving watch floor from 720K down to 500K, triggering the
    // watch tier at 50% of the window instead of the intended 72%.
    autoFloor: Math.floor(contextWindow * ratios.watch),
    toolResultMaxTokens: Math.min(Math.floor(contextWindow * 0.3), toolResultHardCap),
  }
}

/**
 * C4 task anchor: max items rendered per list (constraints / scope / completed /
 * remaining) when the authoritative TaskContract is re-injected into the
 * appendix region after compaction. Keeps the anchor compact so re-injecting it
 * every compaction never meaningfully grows the post-compaction footprint.
 */
export const TASK_ANCHOR_MAX_ITEMS = 6

/** Number of messages to preserve at the start as cache anchor.
 * Keeping the first 2 messages (initial user request + assistant response)
 * preserves the prefix structure after compaction, so DeepSeek's prefix
 * cache can still match [System][Tools][Volatile][User1][Asst1]. */
export const CACHE_ANCHOR_MESSAGES = 2

/** Number of most recent messages to keep during micro-compact */
export const KEEP_RECENT_MESSAGES = 4

/** Minimum number of messages before summarizing (avoid summary of nothing) */
export const MIN_SUMMARIZE_MESSAGES = 6

/** Window size at which large-context behaviors activate (tool result caps, summary budgets). */
export const LARGE_CONTEXT_WINDOW_TOKENS = 500_000

/**
 * LLM compact summary output budget (chars), scaled by window size.
 * llmCompact sends the FULL session history to the compact model (reusing
 * the prefix cache), so input truncation is not the bottleneck — the
 * summary output budget is. A 1M session squashed into a 3000-char summary
 * loses most of its decision history; large windows get a larger budget.
 *
 * `generous` ≈ 2× budget. Used when compaction is routed to a dedicated cheap
 * model (compact.provider+model): the distillation is near-free, so we'd rather
 * keep more decision/file/error detail than over-compress. A bigger summary
 * costs a few KB of prefix on the *main* model, but that's a fair trade for not
 * dropping context the agent later needs.
 */
export function summaryOutputBudgetChars(
  contextWindow: number,
  opts?: { generous?: boolean },
): { full: number; partial: number } {
  const base = contextWindow >= 1_000_000
    ? { full: 8_000, partial: 5_000 }
    : contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS
      ? { full: 6_000, partial: 4_000 }
      : { full: 3_000, partial: 2_000 }
  if (!opts?.generous) return base
  return { full: base.full * 2, partial: base.partial * 2 }
}

export interface CompactionConfig {
  enabled: boolean
  autoThreshold: number
  autoFloor: number
  model: string
  /** Provider hosting the compaction model. When set together with `model`,
   *  compaction is routed to a dedicated cheap client (own cache). Optional. */
  provider?: string
  /** T9 turn-0 quality-compaction trigger ratios (provider cost-aware).
   *  Optional — runtime falls back to DEFAULT_QUALITY_COMPACT_THRESHOLDS when absent. */
  qualityCompact?: {
    perTokenThreshold: number
    subscriptionThreshold: number
    subscriptionCeiling: number
  }
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

/**
 * Precision ceiling: the context-fraction at which compaction MUST trigger,
 * regardless of how favourable the prefix cache is. A model's labelled context
 * window is the *capacity* it can hold, not the range over which its attention
 * stays accurate — needle-in-the-haystack recall degrades well below the
 * labelled window, so pushing compaction to ~0.86 of the window (as
 * cache-economics-only strategies do) leaves the model working in an
 * accuracy-attenuated zone for most of a long session.
 *
 * Unlike the cache-economic ratios above (which may be nudged by hit rate), the
 * precision ceiling is a hard guard: cache strategy may only optimise *under*
 * it. The ceiling is derived from the window size because the degradation curve
 * differs — small windows tolerate a higher fraction before precision drops,
 * large windows hit it sooner.
 *
 * @param contextWindow  the model's labelled context window (tokens)
 * @param override        optional explicit ratio (e.g. from user config); when
 *                        provided and in (0,1), it replaces the derived value.
 */
export function precisionCeilingRatio(contextWindow: number, override?: number): number {
  if (typeof override === 'number' && Number.isFinite(override) && override > 0 && override < 1) {
    return override
  }
  // Only large windows get a precision ceiling. On small/medium windows the
  // cache-economic ratios already compact early enough that model-accuracy
  // degradation isn't the binding constraint, and imposing a ceiling there
  // would fight the cache strategy (e.g. forcing tier 2 at 0.65 of a 1K test
  // window, below the cache-preserving compact ratio of 0.86). The ceiling
  // exists for the 1M-window regime where cache-economics-only defers compaction
  // well past the accuracy cliff. Returning 1 = no ceiling (cache strategy rules).
  if (contextWindow >= LARGE_CONTEXT_WINDOW_TOKENS) return 0.5
  if (contextWindow >= 200_000) return 0.55
  return 1
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

/**
 * Per-tool-type budget: independently limits single-call size and cumulative
 * per-turn output for each tool type. When cumulative output exceeds
 * `summarizeAfter`, subsequent results are auto-truncated to summary form.
 *
 * Addresses session b3d6f29a pattern: 24 grep calls × ~600 tokens each
 * = 14K tokens of low-density fragmented info. The global per-message budget
 * (120K chars) never fires because individual results are small.
 */
export interface ToolTypeBudget {
  perCall: number
  perTurnCumulative: number
  summarizeAfter: number
}

export function toolTypeBudgets(contextWindow: number): Record<string, ToolTypeBudget> {
  const w = contextWindow
  // grep/search: scale with window on large contexts to avoid premature summarization
  // during exploration. perTurnCumulative is not consumed by enforceToolTypeBudgets.
  const grepPerCall = w >= 200_000 ? Math.min(Math.floor(w * 0.004), 8_000) : 2_000
  const grepSummarize = w >= 200_000 ? Math.min(Math.floor(w * 0.008), 16_000) : 4_000
  return {
    grep:      { perCall: grepPerCall, perTurnCumulative: grepSummarize * 2, summarizeAfter: grepSummarize },
    search:    { perCall: grepPerCall, perTurnCumulative: grepSummarize * 2, summarizeAfter: grepSummarize },
    read_file: { perCall: Math.min(w * 0.1, 20_000), perTurnCumulative: Math.min(w * 0.25, 50_000), summarizeAfter: Math.min(w * 0.15, 30_000) },
    bash:      { perCall: 5_000,  perTurnCumulative: 15_000,  summarizeAfter: 8_000 },
    default:   { perCall: 5_000,  perTurnCumulative: 20_000,  summarizeAfter: 10_000 },
  }
}

export function getToolBudget(toolName: string, contextWindow: number): ToolTypeBudget {
  const budgets = toolTypeBudgets(contextWindow)
  return budgets[toolName] ?? budgets['default']!
}
