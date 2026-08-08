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

  it('returns deepseek-spark profile with exact-prefix caching (2026-08-07 gap fix)', () => {
    // Missing entry used to fall back to cacheType 'none' → aggressive compact
    // tiers (51/71/85%) + persistent-exact-prefix delay protections disabled
    // for every spark session.
    const p = getProviderCacheDefaults('deepseek-spark')
    assert.equal(p.cacheType, 'exact-prefix')
    assert.equal(p.persistent, true)
    assert.equal(p.minCacheTokens, 64)
    assert.ok(p.attentionProfile, 'spark inherits the deepseek attention profile')
  })

  it('deepseek-spark carries the 85% compaction schedule overrides', () => {
    // Product decision 2026-08-07 ("85% 再压缩"): no history-rewriting
    // compaction before 85% of the window — tier compact ratio, precision
    // ceiling and the 1M LLM ladder all move together.
    const p = getProviderCacheDefaults('deepseek-spark')
    assert.equal(p.compaction?.ratios?.compact, 0.85)
    assert.equal(p.compaction?.precisionCeiling, 0.85)
    assert.deepEqual(p.compaction?.llmLadder, { partial: 0.85, full: 0.9 })
    // Safety rungs stay strategy-default: only the compact rung is overridden.
    assert.equal(p.compaction?.ratios?.reactive, undefined)
    assert.equal(p.compaction?.ratios?.ceiling, undefined)
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
