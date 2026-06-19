export type CacheType = 'exact-prefix' | 'explicit-breakpoint' | 'partial-prefix' | 'block-kv' | 'none'

export interface AttentionProfile {
  effectiveAttentionRatio: number
  toolDensityThreshold: number
  collapseAgeTurns: number
}

export interface ProviderProfile {
  cacheType: CacheType
  persistent: boolean
  minCacheTokens: number
  cacheGranularity?: number
  ttlSeconds?: number
  contextWindow: number
  attentionProfile?: AttentionProfile
}

const PROFILES: Record<string, Omit<ProviderProfile, 'contextWindow'>> = {
  deepseek: {
    cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64,
    attentionProfile: { effectiveAttentionRatio: 0.95, toolDensityThreshold: 0.7, collapseAgeTurns: 8 },
  },
  anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 300 },
  openai: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  codex: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  google: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 3600 },
  qwen: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },
  vllm: { cacheType: 'block-kv', persistent: false, minCacheTokens: 0 },
  glm: {
    cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0,
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
