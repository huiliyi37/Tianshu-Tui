// DeepSeek V4 pricing (CNY per 1M tokens) from
// https://api-docs.deepseek.com/zh-cn/quick_start/pricing
// Used by InsightsSurface to render cost independently of provider config.

export interface DeepSeekRate {
  name: string
  inputCacheHit: number
  inputCacheMiss: number
  output: number
}

export const DEEPSEEK_RATES: Record<'flash' | 'pro', DeepSeekRate> = {
  flash: {
    name: 'DeepSeek-V4-Flash',
    inputCacheHit: 0.02,
    inputCacheMiss: 1,
    output: 2,
  },
  pro: {
    name: 'DeepSeek-V4-Pro',
    inputCacheHit: 0.025,
    inputCacheMiss: 3,
    output: 6,
  },
}

export interface TokenBreakdown {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
}

/** Infer the DeepSeek rate tier from a model id or alias. */
export function resolveDeepSeekRate(model?: string | null): 'flash' | 'pro' {
  if (!model) return 'flash'
  const id = model.toLowerCase()
  if (id.includes('pro')) return 'pro'
  if (id.includes('flash')) return 'flash'
  // Fallback: legacy deepseek-chat / deepseek-reasoner map to flash modes.
  if (id.includes('deepseek-chat') || id.includes('deepseek-reasoner') || id.includes('deepseek-v4')) return 'flash'
  return 'flash'
}

/**
 * Compute CNY cost from token usage and a DeepSeek V4 model id.
 * Defaults to Flash; picks Pro when the model name contains 'pro'.
 * Cache read is a subset of input; uncached input = input - cacheRead.
 */
export function computeDeepSeekCost(
  usage: TokenBreakdown,
  model?: string | null,
): number {
  const rate = DEEPSEEK_RATES[resolveDeepSeekRate(model)]
  const input = Math.max(0, usage.inputTokens - usage.cacheReadTokens)
  const inputCost = (input / 1_000_000) * rate.inputCacheMiss
  const cacheReadCost = (usage.cacheReadTokens / 1_000_000) * rate.inputCacheHit
  const cacheWriteCost = (usage.cacheWriteTokens / 1_000_000) * rate.inputCacheMiss
  const outputCost = (usage.outputTokens / 1_000_000) * rate.output
  return Math.round((inputCost + cacheReadCost + cacheWriteCost + outputCost) * 1_000_000) / 1_000_000
}

export function formatCny(value: number): string {
  if (value === 0) return '¥0.00'
  if (value < 0.0001) return '<¥0.0001'
  return `¥${value.toFixed(4).replace(/\.?0+$/, '')}`
}
