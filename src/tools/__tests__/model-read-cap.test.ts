import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeModelReadCap,
  DEFAULT_MODEL_READ_CAP,
} from '../model-read-cap.js'

describe('computeModelReadCap', () => {
  it('falls back to legacy 8000 cap when no contextWindow given', () => {
    const cap = computeModelReadCap()
    assert.deepEqual(cap, DEFAULT_MODEL_READ_CAP)
  })

  it('returns the floor for tiny windows (never tighter than legacy)', () => {
    // Even a 1k-token "window" should not give the model fewer chars than
    // the historical default — that would be a regression.
    const cap = computeModelReadCap({ contextWindow: 1_000 })
    assert.equal(cap.maxChars, DEFAULT_MODEL_READ_CAP.maxChars)
  })

  it('scales with context window for the balanced strategy', () => {
    // 200k window, balanced (no provider profile = balanced)
    // Tier: 200K–500K → fraction 0.03
    // 200_000 * 0.03 * 4 * 1.0 = 24_000
    const cap = computeModelReadCap({ contextWindow: 200_000 })
    assert.equal(cap.maxChars, 24_000)
    assert.equal(cap.headChars, 14_400)
    assert.equal(cap.tailChars, 7_200)
  })

  it('uses 5% fraction for ≥500K windows', () => {
    // 500k window, balanced → 500_000 * 0.05 * 4 * 1.0 = 100_000
    const cap = computeModelReadCap({ contextWindow: 500_000 })
    assert.equal(cap.maxChars, 100_000)
  })

  it('uses 2% fraction for <200K windows', () => {
    // 128k window, balanced → 128_000 * 0.02 * 4 * 1.0 = 10_240
    const cap = computeModelReadCap({ contextWindow: 128_000 })
    assert.equal(cap.maxChars, 10_240)
  })

  it('boosts for cache-preserving providers (DeepSeek-style)', () => {
    // 200k, fraction 0.03, cache-preserving ×1.3 → 200_000 * 0.03 * 4 * 1.3 = 31_200
    const cap = computeModelReadCap({
      contextWindow: 200_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
    })
    assert.equal(cap.maxChars, 31_200)
  })

  it('shrinks for aggressive (no-cache) providers', () => {
    // 200k, fraction 0.03, aggressive ×0.65 → 200_000 * 0.03 * 4 * 0.65 = 15_600
    const cap = computeModelReadCap({
      contextWindow: 200_000,
      providerProfile: { cacheType: 'none', persistent: false },
    })
    assert.equal(cap.maxChars, 15_600)
  })

  it('hits the absolute ceiling at 120k chars even on huge windows', () => {
    // 1M window, cache-preserving: 1_000_000 * 0.05 * 4 * 1.3 = 260_000
    // → capped at 120_000 (B1 lowered from 200K).
    const cap = computeModelReadCap({
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
    })
    assert.equal(cap.maxChars, 120_000)
  })

  it('keeps a 60/30 head/tail split', () => {
    const cap = computeModelReadCap({ contextWindow: 200_000 })
    assert.equal(cap.headChars, Math.floor(cap.maxChars * 0.6))
    assert.equal(cap.tailChars, Math.floor(cap.maxChars * 0.3))
    // 10% buffer for the truncation marker
    assert.ok(cap.headChars + cap.tailChars < cap.maxChars)
  })

  it('handles zero / negative contextWindow as "use default"', () => {
    assert.deepEqual(computeModelReadCap({ contextWindow: 0 }), DEFAULT_MODEL_READ_CAP)
    assert.deepEqual(computeModelReadCap({ contextWindow: -1 }), DEFAULT_MODEL_READ_CAP)
  })
})
