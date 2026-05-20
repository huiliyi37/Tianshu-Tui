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
  const providerProfile = typeof input === 'number' ? undefined : input.providerProfile
  const ratios = compactPolicyRatios(providerProfile)
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
