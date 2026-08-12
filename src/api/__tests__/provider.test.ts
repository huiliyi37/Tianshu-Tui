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

describe('Aggregator / relay providers — WELL_KNOWN_DEFAULTS', () => {
  it('siliconflow: thinkingBlock enabled + deepseek-native prefix cache', () => {
    const caps = resolveCapabilities('siliconflow')
    assert.equal(caps.supportsThinking, true)
    assert.equal(caps.thinkingBlockType, 'enabled')
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.equal(caps.prefixCacheStrategy, 'deepseek-native', 'server-side implicit exact-prefix cache')
    assert.ok(caps.stripParams.includes('cache_control'))
    assert.ok(caps.mapUsage, 'reads cached_tokens via DeepSeek-shaped usage')
  })

  it('dashscope: thinkingBlock enabled + response_format supported (OpenAI-compatible endpoint)', () => {
    const caps = resolveCapabilities('dashscope')
    assert.equal(caps.supportsThinking, true)
    assert.equal(caps.thinkingBlockType, 'enabled')
    assert.equal(caps.supportsResponseFormat, true)
    assert.equal(caps.prefixCacheStrategy, 'none', 'OpenAI-compat endpoint does not accept cache_control')
  })

  it('openrouter: no thinking block — only reasoning_effort passthrough', () => {
    const caps = resolveCapabilities('openrouter')
    assert.equal(caps.thinkingBlockType, 'none', 'thinking block passthrough is unstable across the fleet')
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.equal(caps.supportsThinking, true)
  })

  it('relay: generic one-api/new-api template — reasoning_effort passthrough, no thinking block', () => {
    const caps = resolveCapabilities('relay')
    assert.equal(caps.thinkingBlockType, 'none')
    assert.equal(caps.effortFormat, 'reasoning_effort')
    assert.equal(caps.prefixCacheStrategy, 'none')
  })
})

describe('resolveCapabilities — override precedence and thinking derivation', () => {
  it('provider overrides win over WELL_KNOWN defaults', () => {
    const caps = resolveCapabilities('deepseek', { cacheControl: true })
    assert.equal(caps.supportsCacheControl, true, 'explicit cacheControl:true overrides deepseek WELL_KNOWN=false')
    // Unmentioned fields keep WELL_KNOWN values
    assert.equal(caps.thinkingBlockType, 'enabled')
    assert.equal(caps.prefixCacheStrategy, 'deepseek-native')
  })

  it('model overrides win over provider overrides', () => {
    const caps = resolveCapabilities(
      'dashscope',
      { thinkingBlock: 'enabled' },
      { thinkingBlock: 'none', effortFormat: 'none' },
    )
    assert.equal(caps.thinkingBlockType, 'none', 'model-level override takes precedence')
    assert.equal(caps.effortFormat, 'none')
  })

  it('user declaring thinkingBlock=enabled flips supportsThinking=true even for no-thinking providers', () => {
    const caps = resolveCapabilities('longcat', { thinkingBlock: 'enabled' })
    assert.equal(caps.supportsThinking, true)
    assert.equal(caps.thinkingBlockType, 'enabled')
  })

  it('user declaring both block=none and effort=none flips supportsThinking=false', () => {
    const caps = resolveCapabilities('deepseek', {
      thinkingBlock: 'none',
      effortFormat: 'none',
    })
    assert.equal(caps.supportsThinking, false)
  })

  it('user declaring effortFormat alone flips supportsThinking=true and leaves other fields intact', () => {
    const caps = resolveCapabilities('relay', { effortFormat: 'reasoning_effort' })
    assert.equal(caps.supportsThinking, true)
    assert.equal(caps.thinkingBlockType, 'none', 'user did not override block — keeps WELL_KNOWN')
  })

  it('explicit empty stripParams ([]) is honored, not treated as "not declared"', () => {
    const caps = resolveCapabilities('deepseek', { stripParams: [] })
    assert.deepEqual(caps.stripParams, [], 'user explicitly clearing stripParams must be respected')
  })

  it('effortCap override replaces WELL_KNOWN cap wholesale', () => {
    const caps = resolveCapabilities('kimi', { effortCap: { max: 'medium' } })
    assert.deepEqual(caps.effortCap, { max: 'medium' })
  })

  it('resolving with overrides never mutates the shared WELL_KNOWN table', () => {
    resolveCapabilities('deepseek', { cacheControl: true, thinkingBlock: 'none' })
    const fresh = resolveCapabilities('deepseek')
    assert.equal(fresh.supportsCacheControl, false, 'WELL_KNOWN deepseek cacheControl must stay false')
    assert.equal(fresh.thinkingBlockType, 'enabled', 'WELL_KNOWN deepseek thinkingBlock must stay enabled')
  })
})

describe('preservedThinkingProtocol — DeepSeek wire-protocol family', () => {
  it('declared only for DeepSeek-derived providers, not prefix-cache siblings', () => {
    assert.equal(resolveCapabilities('deepseek').preservedThinkingProtocol, true)
    assert.equal(resolveCapabilities('mimo').preservedThinkingProtocol, true)
    // Share deepseek-native prefix cache but have independent reasoning —
    // must NOT inherit the preserved-thinking wire protocol.
    assert.notEqual(resolveCapabilities('glm').preservedThinkingProtocol, true)
    assert.notEqual(resolveCapabilities('longcat').preservedThinkingProtocol, true)
    assert.notEqual(resolveCapabilities('siliconflow').preservedThinkingProtocol, true)
    assert.notEqual(resolveCapabilities('mimo-api').preservedThinkingProtocol, true)
  })

  it('overridable via capabilities (pro spark preset / user config path)', () => {
    const caps = resolveCapabilities('unknown-relay', { preservedThinkingProtocol: true })
    assert.equal(caps.preservedThinkingProtocol, true)
    const off = resolveCapabilities('deepseek', { preservedThinkingProtocol: false })
    assert.equal(off.preservedThinkingProtocol, false)
  })
})
