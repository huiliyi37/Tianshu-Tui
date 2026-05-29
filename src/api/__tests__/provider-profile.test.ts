import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { getProviderProfile } from '../provider-profile.js'

describe('getProviderProfile', () => {
  it('returns deepseek profile', () => {
    const p = getProviderProfile('deepseek')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
    assert.equal(p.minCacheTokens, 64)
  })

  it('returns claude profile', () => {
    const p = getProviderProfile('anthropic')
    assert.equal(p.cacheType, 'explicit-breakpoint')
    assert.equal(p.minCacheTokens, 4096)
  })

  it('returns openai profile', () => {
    const p = getProviderProfile('openai')
    assert.equal(p.cacheType, 'partial-prefix')
    assert.equal(p.cacheGranularity, 128)
  })

  it('returns none profile for unknown', () => {
    const p = getProviderProfile('unknown-local')
    assert.equal(p.cacheType, 'none')
  })

  it('returns minimax profile', () => {
    const p = getProviderProfile('minimax')
    assert.equal(p.cacheType, 'none')
    assert.equal(p.persistent, false)
  })

  it('returns mimo profile', () => {
    const p = getProviderProfile('mimo')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
  })

  it('returns opencode-go profile', () => {
    const p = getProviderProfile('opencode-go')
    assert.equal(p.cacheType, 'none')
  })

  it('returns codex profile with openai-like caching', () => {
    const p = getProviderProfile('codex')
    assert.equal(p.cacheType, 'partial-prefix')
    assert.equal(p.persistent, false)
    assert.equal(p.cacheGranularity, 128)
    assert.equal(p.ttlSeconds, 600)
  })
})
