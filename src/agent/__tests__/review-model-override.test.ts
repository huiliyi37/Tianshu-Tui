import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveReviewOverride, buildReviewOverrideCard } from '../review-model-override.js'
import type { ProviderConfig } from '../../config/schema.js'

const mockProvider = (models: Array<{ id: string; alias?: string; contextWindow: number }>): ProviderConfig =>
  ({
    name: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai' as const,
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'deepseek-native' as const,
      prefixCompletion: false,
    },
    thinking: 'enabled' as const,
    maxTokens: 384000,
    models: models.map(m => ({ id: m.id, alias: m.alias ?? m.id, contextWindow: m.contextWindow, maxTokens: 384000 })),
    unsupported: [],
  }) as unknown as ProviderConfig

describe('resolveReviewOverride', () => {
  it('returns undefined when no override configured for profile', () => {
    const result = resolveReviewOverride(
      'adversarial_verifier',
      {},
      { deepseek: mockProvider([{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }]) },
    )
    assert.equal(result, undefined)
  })

  it('returns undefined when provider does not exist', () => {
    const result = resolveReviewOverride(
      'reviewer',
      { reviewer: { provider: 'nonexistent', model: 'x' } },
      {},
    )
    assert.equal(result, undefined)
  })

  it('returns undefined when model does not exist in provider', () => {
    const providers = { deepseek: mockProvider([{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }]) }
    const result = resolveReviewOverride(
      'reviewer',
      { reviewer: { provider: 'deepseek', model: 'nonexistent-model' } },
      providers,
    )
    assert.equal(result, undefined)
  })

  it('resolves when provider and model exist', () => {
    const providers = { deepseek: mockProvider([{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }]) }
    const result = resolveReviewOverride(
      'reviewer',
      { reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' } },
      providers,
    )
    assert.ok(result)
    assert.equal(result!.providerName, 'deepseek')
    assert.equal(result!.modelId, 'deepseek-v4-flash')
  })

  it('resolves by alias', () => {
    const providers = { deepseek: mockProvider([{ id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000 }]) }
    const result = resolveReviewOverride(
      'reviewer',
      { reviewer: { provider: 'deepseek', model: 'v4-flash' } },
      providers,
    )
    assert.ok(result)
    assert.equal(result!.modelId, 'v4-flash')
  })
})

describe('buildReviewOverrideCard', () => {
  it('classifies flash models as cheap tier scores', () => {
    const provider = mockProvider([{ id: 'deepseek-v4-flash', contextWindow: 1_000_000 }])
    const card = buildReviewOverrideCard('deepseek-v4-flash', provider)
    assert.equal(card.toolUseReliability, 0.6)
    assert.equal(card.contextWindow, 1_000_000)
  })

  it('classifies pro models as strong tier scores', () => {
    const provider = mockProvider([{ id: 'deepseek-v4-pro', contextWindow: 1_000_000 }])
    const card = buildReviewOverrideCard('deepseek-v4-pro', provider)
    assert.equal(card.toolUseReliability, 0.8)
  })

  it('treats neutral names (no pro/flash) as strong — matches bootstrap.ts:578-585', () => {
    const provider = mockProvider([{ id: 'deepseek-v4', contextWindow: 1_000_000 }])
    const card = buildReviewOverrideCard('deepseek-v4', provider)
    assert.equal(card.toolUseReliability, 0.8)
  })

  it('detects tier via alias too', () => {
    const provider = mockProvider([{ id: 'v4-flash', alias: 'flash', contextWindow: 1_000_000 }])
    const card = buildReviewOverrideCard('v4-flash', provider)
    assert.equal(card.toolUseReliability, 0.6)
  })
})
