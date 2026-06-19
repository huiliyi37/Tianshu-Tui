import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProviderCacheDefaults, getProviderProfile } from '../provider-profile.js'

describe('getProviderCacheDefaults', () => {
  it('returns deepseek profile', () => {
    const p = getProviderCacheDefaults('deepseek')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
    assert.equal(p.minCacheTokens, 64)
  })

  it('returns claude profile', () => {
    const p = getProviderCacheDefaults('anthropic')
    assert.equal(p.cacheType, 'explicit-breakpoint')
    assert.equal(p.minCacheTokens, 4096)
  })

  it('returns openai profile', () => {
    const p = getProviderCacheDefaults('openai')
    assert.equal(p.cacheType, 'partial-prefix')
    assert.equal(p.cacheGranularity, 128)
  })

  it('returns none profile for unknown', () => {
    const p = getProviderCacheDefaults('unknown-local')
    assert.equal(p.cacheType, 'none')
  })

  it('returns minimax profile', () => {
    const p = getProviderCacheDefaults('minimax')
    assert.equal(p.cacheType, 'none')
    assert.equal(p.persistent, false)
  })

  it('returns mimo profile', () => {
    const p = getProviderCacheDefaults('mimo')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
  })

  it('returns opencode-go profile', () => {
    const p = getProviderCacheDefaults('opencode-go')
    assert.equal(p.cacheType, 'none')
  })

  it('returns codex profile with openai-like caching', () => {
    const p = getProviderCacheDefaults('codex')
    assert.equal(p.cacheType, 'partial-prefix')
    assert.equal(p.persistent, false)
    assert.equal(p.cacheGranularity, 128)
    assert.equal(p.ttlSeconds, 600)
  })

  it('returns mimo-api profile with exact-prefix caching', () => {
    const p = getProviderCacheDefaults('mimo-api')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
  })

  it('returns kimi profile with no caching', () => {
    const p = getProviderCacheDefaults('kimi')
    assert.equal(p.cacheType, 'none')
    assert.equal(p.persistent, false)
  })
})

describe('getProviderProfile', () => {
  it('uses the explicit context window — no silent 128K fallback', () => {
    const p = getProviderProfile('deepseek', 1_000_000)
    assert.equal(p.contextWindow, 1_000_000)
    assert.equal(p.cacheType, 'exact-prefix')
  })
})
