import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  deriveCompactionProfile,
  windowBandFor,
  cacheKindFromProviderProfile,
  type CompactionProfile,
} from '../compaction-profile.js'

describe('windowBandFor', () => {
  it('classifies the three window bands stably', () => {
    assert.equal(windowBandFor(64_000), 'small')
    assert.equal(windowBandFor(128_000), 'small')
    assert.equal(windowBandFor(200_000), 'medium')
    assert.equal(windowBandFor(256_000), 'medium')
    assert.equal(windowBandFor(500_000), 'large')
    assert.equal(windowBandFor(1_000_000), 'large')
  })
})

describe('cacheKindFromProviderProfile', () => {
  it('maps persistent exact-prefix to exact-prefix', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'exact-prefix', persistent: true }), 'exact-prefix')
  })
  it('maps non-persistent exact-prefix to partial (TTL-bound cache is not a paid persistent prefix)', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'exact-prefix', persistent: false }), 'partial')
  })
  it('maps none to none and other cache types to partial', () => {
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'none', persistent: false }), 'none')
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'partial-prefix', persistent: false }), 'partial')
    assert.equal(cacheKindFromProviderProfile({ cacheType: 'explicit-breakpoint', persistent: false }), 'partial')
    assert.equal(cacheKindFromProviderProfile(undefined), 'none')
  })
})

describe('deriveCompactionProfile', () => {
  it('DeepSeek-style per-token + exact-prefix on 1M gets the high reclaim floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.windowBand, 'large')
    assert.equal(p.minReclaimTokens, Math.max(32_768, Math.floor(1_000_000 * 0.05)))
    assert.equal(p.minReclaimTokens, 50_000)
    assert.equal(p.minReclaimRatio, 0.05)
    assert.equal(p.effectiveInputBudget, 1_000_000)
  })

  it('per-token + exact-prefix at 256k window: floor is max(8192, 3%) = 8192', () => {
    const p = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.windowBand, 'medium')
    // floor(256000*0.03)=7680 < 8192 → 8192 (plan §3.2 self-check)
    assert.equal(p.minReclaimTokens, 8_192)
    assert.equal(p.minReclaimRatio, 0.03)
  })

  it('per-token + exact-prefix at 200k window keeps the small/medium floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 200_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.equal(p.minReclaimTokens, 8_192)
    assert.equal(p.minReclaimRatio, 0.03)
  })

  it('GLM/MiMo-style subscription gets the low floor even with exact-prefix cache', () => {
    const p = deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'subscription', cache: 'exact-prefix' })
    assert.equal(p.minReclaimTokens, Math.max(4_096, Math.floor(1_000_000 * 0.01)))
    assert.equal(p.minReclaimTokens, 10_000)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('Codex-style subscription + partial cache gets the low floor', () => {
    const p = deriveCompactionProfile({ contextWindow: 200_000, billing: 'subscription', cache: 'partial' })
    assert.equal(p.minReclaimTokens, 4_096)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('per-token with NO cache also gets the low floor (no prefix worth protecting)', () => {
    const p = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'none' })
    assert.equal(p.minReclaimTokens, 4_096)
    assert.equal(p.minReclaimRatio, 0.01)
  })

  it('carries billing/cache/prices through verbatim', () => {
    const p: CompactionProfile = deriveCompactionProfile({
      contextWindow: 1_000_000,
      billing: 'per-token',
      cache: 'exact-prefix',
      cacheReadPricePerMillion: 0.2,
      cacheWritePricePerMillion: 2,
    })
    assert.equal(p.billing, 'per-token')
    assert.equal(p.cache, 'exact-prefix')
    assert.equal(p.cacheReadPricePerMillion, 0.2)
    assert.equal(p.cacheWritePricePerMillion, 2)
  })

  it('is deterministic: same input → structurally identical output', () => {
    const a = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    const b = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    assert.deepEqual(a, b)
  })
})
