import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mapDeepSeekUsage, resolveCapabilities } from '../provider.js'

describe('DeepSeek provider usage mapping', () => {
  it('maps native DeepSeek cache counters into standard usage fields', () => {
    assert.deepEqual(mapDeepSeekUsage({
      prompt_tokens: 1000,
      completion_tokens: 200,
      prompt_cache_hit_tokens: 875,
      prompt_cache_miss_tokens: 125,
    }), {
      input_tokens: 1000,
      output_tokens: 200,
      cache_read_input_tokens: 875,
      cache_creation_input_tokens: 125,
    })
  })

  it('exposes DeepSeek usage mapping through resolved capabilities', () => {
    const capabilities = resolveCapabilities('deepseek')

    assert.deepEqual(capabilities.mapUsage?.({
      prompt_tokens: 400,
      completion_tokens: 50,
      prompt_cache_hit_tokens: 300,
      prompt_cache_miss_tokens: 100,
    }), {
      input_tokens: 400,
      output_tokens: 50,
      cache_read_input_tokens: 300,
      cache_creation_input_tokens: 100,
    })
  })
})

describe('GLM provider implicit prefix cache', () => {
  it('resolves GLM as a deepseek-native (implicit exact-prefix) cache provider', () => {
    const capabilities = resolveCapabilities('glm')
    assert.equal(capabilities.prefixCacheStrategy, 'deepseek-native')
    assert.ok(capabilities.mapUsage, 'GLM must expose a usage mapping to read cached_tokens')
  })

  it('maps GLM OpenAI-style prompt_tokens_details.cached_tokens into cache_read_input_tokens', () => {
    const capabilities = resolveCapabilities('glm')
    assert.deepEqual(capabilities.mapUsage?.({
      prompt_tokens: 1200,
      completion_tokens: 300,
      prompt_tokens_details: { cached_tokens: 800 },
    }), {
      input_tokens: 1200,
      output_tokens: 300,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 0,
    })
  })
})

describe('LongCat provider explicit defaults (W4 — no implicit DEFAULT fallback)', () => {
  it('resolves longcat with response_format disabled — worker repair must run as plain-text re-ask', () => {
    const capabilities = resolveCapabilities('longcat')
    assert.equal(capabilities.supportsResponseFormat, false, 'LongCat API has no response_format — json-mode repair unusable')
    assert.equal(capabilities.supportsCacheControl, false, 'no cache_control breakpoints — implicit server-side prefix caching')
    assert.ok(capabilities.stripParams.includes('cache_control'))
    assert.equal(capabilities.prefixCacheStrategy, 'deepseek-native')
    assert.ok(capabilities.mapUsage, 'must read cached_tokens for free cache hits')
  })
})
