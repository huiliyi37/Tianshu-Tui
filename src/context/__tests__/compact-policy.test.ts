import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompactTier, tierForRatio, recordCompactFailure, recordCompactSuccess } from '../compact-policy.js'
import { precisionCeilingRatio } from '../../compact/constants.js'

describe('compact policy', () => {
  it('chooses progressive tiers from balanced token ratio', () => {
    assert.deepEqual(decideCompactTier({ estimatedTokens: 100, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }), {
      tier: 0,
      reason: 'context usage below watch threshold',
      shouldCompact: false,
    })
    assert.equal(decideCompactTier({ estimatedTokens: 650, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 1)
    assert.equal(decideCompactTier({ estimatedTokens: 820, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 2)
    assert.equal(decideCompactTier({ estimatedTokens: 900, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } }).tier, 3)
    const ceiling = decideCompactTier({ estimatedTokens: 980, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 } })
    assert.equal(ceiling.tier, 4)
    assert.equal(ceiling.reason, 'context ceiling exceeded; checkpoint-resume required')
  })

  it('delays compaction for persistent exact-prefix providers', () => {
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }

    assert.equal(decideCompactTier({ estimatedTokens: 700, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 0)
    assert.equal(decideCompactTier({ estimatedTokens: 730, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 1)
    assert.equal(decideCompactTier({ estimatedTokens: 870, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 2)
    assert.equal(decideCompactTier({ estimatedTokens: 930, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 3)
  })

  it('compacts earlier for no-cache providers', () => {
    const providerProfile = { cacheType: 'none' as const, persistent: false }

    assert.equal(decideCompactTier({ estimatedTokens: 490, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 0)
    assert.equal(decideCompactTier({ estimatedTokens: 510, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 1)
    assert.equal(decideCompactTier({ estimatedTokens: 710, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 2)
    assert.equal(decideCompactTier({ estimatedTokens: 850, maxTokens: 1000, turn: 1, failures: { consecutiveFailures: 0 }, providerProfile }).tier, 3)
  })

  it('disables automatic compact temporarily after repeated failures', () => {
    const first = recordCompactFailure({ consecutiveFailures: 0 }, 10)
    const second = recordCompactFailure(first, 11)
    const third = recordCompactFailure(second, 12)

    assert.equal(third.consecutiveFailures, 3)
    assert.equal(third.disabledUntilTurn, 15)
    assert.equal(decideCompactTier({ estimatedTokens: 900, maxTokens: 1000, turn: 13, failures: third }).shouldCompact, false)
    assert.deepEqual(recordCompactSuccess(third), { consecutiveFailures: 0 })
  })
})

describe('precision ceiling', () => {
  it('forces compaction on a large window even with a hot exact-prefix cache', () => {
    // 1M window, exact-prefix persistent, cache fully hot (recentHitRate 0.95).
    // Without the ceiling the cache-preserving ratios (compact 0.86) would let
    // context grow to 860K before compacting; the ceiling forces it at 500K.
    const largeWindow = 1_000_000
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }
    // At 0.48 (480K) — below ceiling, below cache-preserving compact → tier 0/1.
    assert.ok(tierForRatio(0.48, providerProfile, 0.95, precisionCeilingRatio(largeWindow)) < 2)
    // At 0.51 (510K) — past the 0.5 ceiling → forced to tier >= 2 despite hot cache.
    assert.ok(tierForRatio(0.51, providerProfile, 0.95, precisionCeilingRatio(largeWindow)) >= 2)
  })

  it('does not impose a ceiling on small windows (cache strategy rules)', () => {
    // A 1K window: precisionCeilingRatio returns 1 (no ceiling), so the
    // cache-preserving compact ratio (0.86) governs — 0.7 stays tier 0.
    assert.equal(precisionCeilingRatio(1_000), 1)
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }
    assert.equal(tierForRatio(0.7, providerProfile, null, precisionCeilingRatio(1_000)), 0)
  })

  it('scales the ceiling down for larger windows', () => {
    assert.equal(precisionCeilingRatio(1_000_000), 0.5)
    assert.equal(precisionCeilingRatio(300_000), 0.55)
    assert.equal(precisionCeilingRatio(1_000), 1)
  })

  it('honours an explicit override over the window-derived value', () => {
    assert.equal(precisionCeilingRatio(1_000_000, 0.7), 0.7)
    assert.equal(precisionCeilingRatio(1_000, 0.4), 0.4)
  })

  it('decideCompactTier threads the ceiling through end-to-end', () => {
    // 1M window, exact-prefix, hot cache: 510K tokens should recommend compaction.
    const d = decideCompactTier({
      estimatedTokens: 510_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.95,
    })
    assert.ok(d.tier >= 2)
    assert.equal(d.shouldCompact, true)
  })
})