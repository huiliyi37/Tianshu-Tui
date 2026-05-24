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
    // 200_000 * 0.05 * 4 * 1.0 = 40_000
    const cap = computeModelReadCap({ contextWindow: 200_000 })
    assert.equal(cap.maxChars, 40_000)
    assert.equal(cap.headChars, 24_000)
    assert.equal(cap.tailChars, 12_000)
  })

  it('boosts for cache-preserving providers (DeepSeek-style)', () => {
    // 200k * 0.05 * 4 * 1.3 = 52_000
    const cap = computeModelReadCap({
      contextWindow: 200_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
    })
    assert.equal(cap.maxChars, 52_000)
  })

  it('shrinks for aggressive (no-cache) providers', () => {
    // 200k * 0.05 * 4 * 0.65 = 26_000
    const cap = computeModelReadCap({
      contextWindow: 200_000,
      providerProfile: { cacheType: 'none', persistent: false },
    })
    assert.equal(cap.maxChars, 26_000)
  })

  it('hits the absolute ceiling at 200k chars even on huge windows', () => {
    // 1M window, cache-preserving: 1_000_000 * 0.05 * 4 * 1.3 = 260_000
    // → capped at 200_000.
    const cap = computeModelReadCap({
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
    })
    assert.equal(cap.maxChars, 200_000)
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
