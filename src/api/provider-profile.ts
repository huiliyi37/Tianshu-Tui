export type CacheType = 'exact-prefix' | 'explicit-breakpoint' | 'partial-prefix' | 'block-kv' | 'none'

export interface ProviderProfile {
  cacheType: CacheType
  persistent: boolean
  minCacheTokens: number
  cacheGranularity?: number
  ttlSeconds?: number
  contextWindow: number
}

const PROFILES: Record<string, Omit<ProviderProfile, 'contextWindow'>> = {
  deepseek: { cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64 },
  anthropic: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 300 },
  openai: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  codex: { cacheType: 'partial-prefix', persistent: false, minCacheTokens: 1024, cacheGranularity: 128, ttlSeconds: 600 },
  google: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 4096, ttlSeconds: 3600 },
  qwen: { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300 },
  vllm: { cacheType: 'block-kv', persistent: false, minCacheTokens: 0 },
  glm: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  minimax: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  mimo: { cacheType: 'exact-prefix' as CacheType, persistent: true, minCacheTokens: 0 },
  'opencode-go': { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
  claude: { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 },
}

export function getProviderProfile(provider: string, contextWindow?: number): ProviderProfile {
  const base = PROFILES[provider] ?? { cacheType: 'none' as CacheType, persistent: false, minCacheTokens: 0 }
  return { ...base, contextWindow: contextWindow ?? 128_000 }
}
