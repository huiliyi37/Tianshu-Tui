import { describe, it } from 'node:test'
import assert from 'node:assert'
import { computeUsageCost, findModelPricing, formatCost, formatTokens } from '../pricing.js'
import type { ProviderConfig } from '../../config/schema.js'

const providers: Record<string, ProviderConfig> = {
  deepseek: {
    name: 'deepseek',
    baseUrl: 'https://api.deepseek.com/v1',
    models: [
      {
        id: 'deepseek-v4-pro',
        alias: 'v4-pro',
        contextWindow: 1_000_000,
        maxTokens: 384_000,
        pricing: { input: 1.0, output: 4.0, cacheRead: 0.1, cacheWrite: 1.0 },
      },
    ],
  },
} as unknown as Record<string, ProviderConfig>

describe('pricing', () => {
  it('computes zero cost when pricing is missing', () => {
    const cost = computeUsageCost({ input_tokens: 1000, output_tokens: 500 }, undefined)
    assert.strictEqual(cost.total, 0)
  })

  it('computes input/output cost', () => {
    const cost = computeUsageCost(
      { input_tokens: 1_000_000, output_tokens: 500_000 },
      { input: 1.0, output: 4.0 },
    )
    assert.strictEqual(cost.input, 1.0)
    assert.strictEqual(cost.output, 2.0)
    assert.strictEqual(cost.total, 3.0)
  })

  it('splits cache read from uncached input', () => {
    const cost = computeUsageCost(
      { input_tokens: 1_000_000, cache_read_input_tokens: 800_000, output_tokens: 0 },
      { input: 1.0, cacheRead: 0.1 },
    )
    assert.strictEqual(cost.input, 0.2)
    assert.strictEqual(cost.cacheRead, 0.08)
    assert.strictEqual(cost.total, 0.28)
  })

  it('finds pricing by provider and model id', () => {
    const pricing = findModelPricing(providers, 'deepseek', 'deepseek-v4-pro')
    assert.deepStrictEqual(pricing, { input: 1.0, output: 4.0, cacheRead: 0.1, cacheWrite: 1.0 })
  })

  it('finds pricing by model alias', () => {
    const pricing = findModelPricing(providers, 'deepseek', 'v4-pro')
    assert.strictEqual(pricing?.input, 1.0)
  })

  it('returns undefined for unknown provider or model', () => {
    assert.strictEqual(findModelPricing(providers, 'unknown', 'deepseek-v4-pro'), undefined)
    assert.strictEqual(findModelPricing(providers, 'deepseek', 'unknown'), undefined)
  })

  it('formats cost and tokens', () => {
    assert.strictEqual(formatCost(0), '$0.00')
    assert.strictEqual(formatCost(0.00123), '$0.0012')
    assert.strictEqual(formatTokens(1_500), '1.5k')
    assert.strictEqual(formatTokens(1_500_000), '1.50M')
  })
})
