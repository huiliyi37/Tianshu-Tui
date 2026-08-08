export type CacheType = 'exact-prefix' | 'explicit-breakpoint' | 'partial-prefix' | 'block-kv' | 'none'

export interface AttentionProfile {
  effectiveAttentionRatio: number
  toolDensityThreshold: number
  collapseAgeTurns: number
}

/**
 * Provider-specific compaction-schedule overrides. Absent = the strategy
 * defaults derived from cacheType/persistent apply unchanged. Consumed at the
 * derivation points (compactPolicyRatios / decideCompactTier /
 * decideCompactAction) so no call site needs provider special-casing.
 * Structural duplicate of CompactPolicyRatios fields to avoid an
 * api→compact import cycle (compact/constants already imports this module).
 */
export interface ProviderCompactionOverrides {
  /** Partial override of the strategy tier ratios (watch/compact/reactive/ceiling). */
  ratios?: { watch?: number; compact?: number; reactive?: number; ceiling?: number }
  /** Replaces the window-derived precision ceiling (accuracy guard). An
   *  explicit user-config override still wins over this provider default. */
  precisionCeiling?: number
  /** 1M-window LLM compact ladder rungs (partial/full rewrite trigger ratios). */
  llmLadder?: { partial: number; full: number }
}

export interface ProviderProfile {
  cacheType: CacheType
  persistent: boolean
  minCacheTokens: number
  cacheGranularity?: number
  ttlSeconds?: number
  contextWindow: number
  attentionProfile?: AttentionProfile
  compaction?: ProviderCompactionOverrides
}

const PROFILES: Record<string, Omit<ProviderProfile, 'contextWindow'>> = {
  deepseek: {
    cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64,
    attentionProfile: { effectiveAttentionRatio: 0.95, toolDensityThreshold: 0.7, collapseAgeTurns: 8 },
  },
  // Spark (DeepSeek 极速版): same official endpoint & cache semantics as the
  // deepseek entry. Was missing entirely until 2026-08-07 — the 'none'
  // fallback silently degraded the whole compact ladder (aggressive tiers at
  // 51/71/85% instead of 73/87/93%) and disabled the persistent-exact-prefix
  // delay protections for every spark session.
  // compaction overrides (product decision 2026-08-07, "85% 再压缩"): spark
  // sessions defer history-rewriting compaction until 85% of the window —
  // tier compact ratio, the 1M precision ceiling, and the 1M LLM ladder all
  // move to 0.85 (full-llm rung 0.90; reactive/ceiling guards stay put).
  'deepseek-spark': {
    cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64,
    attentionProfile: { effectiveAttentionRatio: 0.95, toolDensityThreshold: 0.7, collapseAgeTurns: 8 },
    compaction: {
      ratios: { compact: 0.85 },
      precisionCeiling: 0.85,
      llmLadder: { partial: 0.85, full: 0.9 },
    },
  },
  anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 300 },
  openai: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  codex: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  google: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 3600 },
  qwen: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },
  vllm: { cacheType: 'block-kv', persistent: false, minCacheTokens: 0 },
  glm: {
    // GLM-5.2 supports implicit exact-prefix context cache (隐式缓存) like DeepSeek —
    // see docs.bigmodel.cn/cn/guide/capabilities/cache. Marking it cache-preserving
    // lets compaction protect the stable prefix instead of triggering 600K-token
    // cache-miss reprefills that time out on the 1M window.
    cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 64,
    attentionProfile: { effectiveAttentionRatio: 0.85, toolDensityThreshold: 0.6, collapseAgeTurns: 4 },
  },
  minimax: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  mimo: {
    cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 0,
    attentionProfile: { effectiveAttentionRatio: 0.9, toolDensityThreshold: 0.65, collapseAgeTurns: 6 },
  },
  'mimo-api': {
    cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 0,
    attentionProfile: { effectiveAttentionRatio: 0.9, toolDensityThreshold: 0.65, collapseAgeTurns: 6 },
  },
  kimi: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  'opencode-go': { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  claude: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  longcat: {
    // LongCat has server-side implicit exact-prefix caching (cache hits free
    // per official pricing). Same treatment as GLM: cache-preserving so
    // compaction protects the stable prefix on the 1M window.
    cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 64,
    attentionProfile: { effectiveAttentionRatio: 0.85, toolDensityThreshold: 0.6, collapseAgeTurns: 4 },
  },
  ccswitch: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
}

/**
 * Cache-strategy defaults for a provider, without a context window.
 * Use this when only cache metadata is needed (e.g. provider registry).
 */
export function getProviderCacheDefaults(provider: string): Omit<ProviderProfile, 'contextWindow'> {
  return PROFILES[provider] ?? { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 }
}

/**
 * Full provider profile. `contextWindow` must come from the resolved model
 * config — the previous silent 128K fallback made 1M models (DeepSeek V4)
 * inherit premature compaction tiers whenever a caller forgot to plumb the
 * window through.
 */
export function getProviderProfile(provider: string, contextWindow: number): ProviderProfile {
  return { ...getProviderCacheDefaults(provider), contextWindow }
}
