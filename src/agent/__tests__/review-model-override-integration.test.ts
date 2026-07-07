import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reviewConfigSchema, agentSchema, configSchema, type ProviderConfig } from '../../config/schema.js'
import { buildReviewOverrideState } from '../review-model-override.js'
import type { ModelCapabilityCard } from '../../model/capability.js'

function makeGLMProvider(): ProviderConfig {
  return {
    name: 'glm',
    apiKeyEnv: 'ZHIPU_API_KEY',
    baseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
    protocol: 'openai',
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'none',
      prefixCompletion: false,
    },
    thinking: 'enabled',
    maxTokens: 131072,
    models: [
      { id: 'glm-5.2', alias: 'glm', contextWindow: 1_000_000, maxTokens: 131072, reasoningEffort: 'high' },
    ],
    unsupported: ['stream_options'],
  } as unknown as ProviderConfig
}

function makeDeepSeekProvider(): ProviderConfig {
  return {
    name: 'deepseek',
    apiKeyEnv: 'DEEPSEEK_API_KEY',
    baseUrl: 'https://api.deepseek.com/v1',
    protocol: 'openai',
    capabilities: {
      cacheControl: false,
      stripParams: [],
      toolJsonBug: true,
      prefixCache: 'deepseek-native',
      prefixCompletion: true,
    },
    thinking: 'enabled',
    maxTokens: 384000,
    models: [
      { id: 'deepseek-v4-pro', alias: 'v4-pro', contextWindow: 1_000_000, maxTokens: 384000, reasoningEffort: 'max' },
      { id: 'deepseek-v4-flash', alias: 'v4-flash', contextWindow: 1_000_000, maxTokens: 384000, reasoningEffort: 'high' },
    ],
    unsupported: [],
  } as unknown as ProviderConfig
}

function makeAnthropicProvider(): ProviderConfig {
  return {
    name: 'anthropic',
    apiKeyEnv: 'ANTHROPIC_API_KEY',
    baseUrl: 'https://api.anthropic.com/v1',
    protocol: 'anthropic',
    capabilities: {
      cacheControl: true,
      stripParams: [],
      toolJsonBug: false,
      prefixCache: 'claude-prompt-cache',
      prefixCompletion: false,
    },
    thinking: 'enabled',
    maxTokens: 8192,
    models: [
      { id: 'claude-3-5-sonnet', alias: 'sonnet', contextWindow: 200_000, maxTokens: 8192, reasoningEffort: 'high' },
    ],
    unsupported: [],
  } as unknown as ProviderConfig
}

/** Exercise the same helper bootstrap.ts uses to build per-profile override
 *  state. This is the actual production path (no in-test duplication of the
 *  loop), so regressions in the helper's contract surface here. */
function buildReviewCards(
  reviewProfiles: Record<string, { provider: string; model: string }>,
  providers: Record<string, ProviderConfig>,
): Map<string, ModelCapabilityCard> {
  return buildReviewOverrideState(reviewProfiles, providers).cards
}

describe('review model override — schema → resolve → card path', () => {
  it('parses a real review config block through the full config schema', () => {
    const providers = { glm: makeGLMProvider(), deepseek: makeDeepSeekProvider() }
    const parsed = configSchema.parse({
      provider: { default: 'glm', providers },
      agent: {
        review: {
          skipAuto: false,
          profiles: {
            adversarial_verifier: { provider: 'deepseek', model: 'deepseek-v4-flash' },
            reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' },
          },
        },
      },
    })

    assert.equal(parsed.agent.review?.skipAuto, false)
    assert.equal(parsed.agent.review?.profiles.adversarial_verifier?.provider, 'deepseek')
    assert.equal(parsed.agent.review?.profiles.adversarial_verifier?.model, 'deepseek-v4-flash')
  })

  it('review.skipAuto defaults to false and profiles to empty', () => {
    const parsed = agentSchema.parse({})
    assert.equal(parsed.review.skipAuto, false)
    assert.deepEqual(parsed.review.profiles, {})
  })

  it('GLM session with deepseek review override: cards route to deepseek, not glm', () => {
    const providers = { glm: makeGLMProvider(), deepseek: makeDeepSeekProvider() }
    const reviewProfiles = {
      adversarial_verifier: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' },
    }

    const cards = buildReviewCards(reviewProfiles, providers)
    assert.equal(cards.size, 2)

    const verifierCard = cards.get('adversarial_verifier')!
    assert.equal(verifierCard.model, 'deepseek-v4-flash', 'card must reflect override, not primary glm-5.2')
    assert.equal(verifierCard.toolUseReliability, 0.6, 'flash model → cheap tier scores')
  })

  it('unknown provider in review config: card not built, profile falls back to primary', () => {
    const providers = { glm: makeGLMProvider() }
    const reviewProfiles = {
      reviewer: { provider: 'nonexistent', model: 'x' },
    }

    const cards = buildReviewCards(reviewProfiles, providers)
    assert.equal(cards.size, 0, 'unresolved provider must not produce a card')
  })

  it('unknown model in known provider: card not built', () => {
    const providers = { deepseek: makeDeepSeekProvider() }
    const reviewProfiles = {
      reviewer: { provider: 'deepseek', model: 'gpt-99' },
    }

    const cards = buildReviewCards(reviewProfiles, providers)
    assert.equal(cards.size, 0, 'unknown model must not produce a card')
  })

  it('mixed provider+model pair: anthropic sonnet override routes correctly', () => {
    const providers = { glm: makeGLMProvider(), anthropic: makeAnthropicProvider() }
    const reviewProfiles = {
      patcher: { provider: 'anthropic', model: 'sonnet' },
    }

    const cards = buildReviewCards(reviewProfiles, providers)
    assert.equal(cards.size, 1)
    assert.equal(cards.get('patcher')?.model, 'sonnet')
    // Sonnet has no 'flash' or 'pro' in its name → defaults to strong tier
    assert.equal(cards.get('patcher')?.toolUseReliability, 0.8)
  })

  it('review.skipAuto:true survives full config round-trip', () => {
    const providers = { glm: makeGLMProvider() }
    const parsed = configSchema.parse({
      provider: { default: 'glm', providers },
      agent: { review: { skipAuto: true, profiles: {} } },
    })
    assert.equal(parsed.agent.review?.skipAuto, true)
  })

  it('reviewConfigSchema alone is parseable as a standalone block', () => {
    const parsed = reviewConfigSchema.parse({
      skipAuto: true,
      profiles: { reviewer: { provider: 'glm', model: 'glm-5.2' } },
    })
    assert.equal(parsed.skipAuto, true)
    assert.equal(parsed.profiles.reviewer?.model, 'glm-5.2')
  })
})

describe('buildReviewOverrideState', () => {
  it('returns empty maps when no profiles configured', () => {
    const state = buildReviewOverrideState({}, { deepseek: makeDeepSeekProvider() })
    assert.equal(state.cards.size, 0)
    assert.equal(state.overrides.size, 0)
  })

  it('populates both cards and overrides maps with consistent entries', () => {
    const providers = { glm: makeGLMProvider(), deepseek: makeDeepSeekProvider() }
    const reviewProfiles = {
      adversarial_verifier: { provider: 'deepseek', model: 'deepseek-v4-flash' },
      reviewer: { provider: 'deepseek', model: 'deepseek-v4-pro' },
    }
    const state = buildReviewOverrideState(reviewProfiles, providers)
    assert.equal(state.cards.size, 2)
    assert.equal(state.overrides.size, 2)
    // Both maps keyed identically and reference the same resolved model
    assert.equal(state.cards.get('adversarial_verifier')!.model, 'deepseek-v4-flash')
    assert.equal(state.overrides.get('adversarial_verifier')!.modelId, 'deepseek-v4-flash')
    assert.equal(state.cards.get('reviewer')!.model, 'deepseek-v4-pro')
    assert.equal(state.overrides.get('reviewer')!.modelId, 'deepseek-v4-pro')
  })

  it('drops profiles with unknown provider — neither card nor override is built', () => {
    const providers = { glm: makeGLMProvider() }
    const state = buildReviewOverrideState(
      { reviewer: { provider: 'nonexistent', model: 'x' } },
      providers,
    )
    assert.equal(state.cards.size, 0)
    assert.equal(state.overrides.size, 0)
  })

  it('drops profiles with unknown model — neither card nor override is built', () => {
    const providers = { deepseek: makeDeepSeekProvider() }
    const state = buildReviewOverrideState(
      { reviewer: { provider: 'deepseek', model: 'gpt-99' } },
      providers,
    )
    assert.equal(state.cards.size, 0)
    assert.equal(state.overrides.size, 0)
  })

  it('partial failure: one profile resolves, another fails — only successful one appears', () => {
    const providers = { deepseek: makeDeepSeekProvider() }
    const state = buildReviewOverrideState(
      {
        reviewer: { provider: 'deepseek', model: 'deepseek-v4-flash' },
        unknown: { provider: 'nonexistent', model: 'x' },
      },
      providers,
    )
    assert.equal(state.cards.size, 1)
    assert.equal(state.overrides.size, 1)
    assert.ok(state.cards.has('reviewer'))
    assert.ok(state.overrides.has('reviewer'))
    assert.ok(!state.cards.has('unknown'))
    assert.ok(!state.overrides.has('unknown'))
  })
})
