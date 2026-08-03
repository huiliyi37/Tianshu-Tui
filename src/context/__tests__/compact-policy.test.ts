import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompactTier, decideCompactAction, tierForRatio, recordCompactFailure, recordCompactSuccess } from '../compact-policy.js'
import { precisionCeilingRatio } from '../../compact/constants.js'
import { deriveCompactionProfile } from '../../compact/compaction-profile.js'

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
    // context grow to 860K before compacting; the ceiling forces it at 700K.
    const largeWindow = 1_000_000
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }
    // At 0.69 (690K) — below ceiling, below cache-preserving compact → tier 0/1.
    assert.ok(tierForRatio(0.69, providerProfile, 0.95, precisionCeilingRatio(largeWindow)) < 2)
    // At 0.71 (710K) — past the 0.7 ceiling → forced to tier >= 2 despite hot cache.
    assert.ok(tierForRatio(0.71, providerProfile, 0.95, precisionCeilingRatio(largeWindow)) >= 2)
  })

  it('the ceiling is a floor, not a fallback — the ladder never inverts', () => {
    // The ceiling (0.70) sits just below the cache-preserving watch threshold
    // (0.72). When it was a trailing `return 2` branch, the watch check
    // shadowed it: 0.71 compacted while the *higher* 0.75 only watched.
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }
    const ceiling = precisionCeilingRatio(1_000_000)
    const tiers = [0.69, 0.71, 0.75, 0.87, 0.93, 0.96]
      .map(r => tierForRatio(r, providerProfile, null, ceiling))

    for (let i = 1; i < tiers.length; i++) {
      assert.ok(
        tiers[i]! >= tiers[i - 1]!,
        `tier must not drop as usage rises: ${JSON.stringify(tiers)}`,
      )
    }
    assert.deepEqual(tiers, [0, 2, 2, 2, 3, 4])
  })

  it('keeps the watch tier reachable when the ceiling sits above it', () => {
    // Balanced strategy (watch 0.60) with no ceiling: the floor must not
    // swallow tier 1 for providers the ceiling does not apply to.
    assert.equal(tierForRatio(0.65, undefined, null, precisionCeilingRatio(1_000)), 1)
  })

  it('does not impose a ceiling on small windows (cache strategy rules)', () => {
    // A 1K window: precisionCeilingRatio returns 1 (no ceiling), so the
    // cache-preserving compact ratio (0.86) governs — 0.7 stays tier 0.
    assert.equal(precisionCeilingRatio(1_000), 1)
    const providerProfile = { cacheType: 'exact-prefix' as const, persistent: true }
    assert.equal(tierForRatio(0.7, providerProfile, null, precisionCeilingRatio(1_000)), 0)
  })

  it('scales the ceiling down for larger windows', () => {
    // 0.7 keeps the ceiling just under the cache-preserving watch threshold
    // (0.72) instead of halving it, which is what 0.5 did.
    assert.equal(precisionCeilingRatio(1_000_000), 0.7)
    assert.equal(precisionCeilingRatio(300_000), 0.55)
    assert.equal(precisionCeilingRatio(1_000), 1)
  })

  it('honours an explicit override over the window-derived value', () => {
    assert.equal(precisionCeilingRatio(1_000_000, 0.55), 0.55)
    assert.equal(precisionCeilingRatio(1_000, 0.4), 0.4)
  })

  it('decideCompactAction: 1M/510k DeepSeek hot cache now sits below the ceiling and does nothing', () => {
    // Was the precision-risk fixture back when the ceiling was 0.5. At 0.7 a
    // half-full 1M window is simply not a concern — this is the point of the
    // change: stop reclaiming at 51% of a window the provider caches well.
    const d = decideCompactAction({
      estimatedTokens: 510_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.95,
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.precisionRisk, false)
    assert.equal(d.action, 'none')
    assert.equal(d.force, false)
  })

  it('decideCompactAction: precision-risk still yields a gated deterministic reclaim, never a forced LLM rewrite', () => {
    // With the default 0.7 ceiling this band is empty on the 1M path — the LLM
    // ladder (partial at 0.60) claims everything above it first. The branch
    // stays reachable through precisionCeilingOverride, which is the only way
    // a user can ask for accuracy-first reclaim below the ladder.
    const d = decideCompactAction({
      estimatedTokens: 510_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.95,
      precisionCeilingOverride: 0.5,
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.precisionRisk, true)
    assert.equal(d.action, 'stale-round')
    assert.notEqual(d.action, 'full-llm')
    assert.equal(d.force, false)
    assert.match(d.reason, /precision-risk/)
  })

  // The rung that ships to every DeepSeek user. It sat at 0.60 from the
  // token-explosion P1 fix (5482542) and was nominally covered by the cache
  // advisor, but `protection = hitRate × (1 − pressure) ≥ 0.45` tops out at
  // 0.55 pressure with a perfect hit rate — it could never reach 0.60, so a
  // 99%-hit session rewrote history there anyway. These lock the ladder that
  // replaced it; a regression is silent otherwise (compaction leaves no
  // user-visible trace beyond a cache-miss spike).
  for (const ratio of [0.60, 0.65, 0.70, 0.74]) {
    it(`decideCompactAction: 1M/${(ratio * 100).toFixed(0)}% per-token exact-prefix (DeepSeek) does not reach an LLM rung`, () => {
      const d = decideCompactAction({
        estimatedTokens: Math.round(1_000_000 * ratio),
        maxTokens: 1_000_000,
        turn: 1,
        failures: { consecutiveFailures: 0 },
        providerProfile: { cacheType: 'exact-prefix', persistent: true },
        recentHitRate: 0.99,
        profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
      })
      assert.notEqual(d.action, 'partial-llm')
      assert.notEqual(d.action, 'full-llm')
      assert.equal(d.force, false)
    })
  }

  it('decideCompactAction: 1M/75% per-token exact-prefix (DeepSeek) reaches partial-llm', () => {
    const d = decideCompactAction({
      estimatedTokens: 750_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.99,
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'partial-llm')
    assert.equal(d.force, false)
  })

  it('decideCompactAction: 1M/85% per-token exact-prefix (DeepSeek) reaches full-llm', () => {
    const d = decideCompactAction({
      estimatedTokens: 850_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.99,
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'full-llm')
  })

  it('decideCompactAction: subscription keeps the base ladder — flat billing makes an early reclaim free', () => {
    // The split mirrors T9's `cachePreserving && !costInsensitive` (3ffcf273):
    // a subscription provider loses latency to a re-prefill, not money.
    const d = decideCompactAction({
      estimatedTokens: 650_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'subscription', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'partial-llm')
  })

  it('decideCompactAction: 1M/650k subscription (GLM) reaches partial-llm without force', () => {
    const d = decideCompactAction({
      estimatedTokens: 650_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'subscription', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'partial-llm')
    assert.equal(d.force, false)
  })

  it('decideCompactAction: 1M/900k DeepSeek reaches full-llm, still non-force (advisor may delay)', () => {
    const d = decideCompactAction({
      estimatedTokens: 900_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'full-llm')
    assert.equal(d.force, false)
  })

  it('decideCompactAction: 1M/960k crosses the hard ceiling — checkpoint with force=true', () => {
    const d = decideCompactAction({
      estimatedTokens: 960_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile: deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' }),
    })
    assert.equal(d.action, 'checkpoint')
    assert.equal(d.force, true)
  })

  it('decideCompactAction: 256k windows use the same action vocabulary, never the 1M LLM ladder', () => {
    const profile = deriveCompactionProfile({ contextWindow: 256_000, billing: 'per-token', cache: 'exact-prefix' })
    // 0.78 of 256k on a cache-preserving provider: watch tier → deterministic micro.
    const mid = decideCompactAction({
      estimatedTokens: 200_000,
      maxTokens: 256_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile,
    })
    assert.equal(mid.action, 'micro')
    assert.equal(mid.force, false)
    // Over the 0.95 ceiling on a medium window: forced micro (emergency
    // deterministic reclaim), checkpoint stays owned by enforceContextCeiling.
    const over = decideCompactAction({
      estimatedTokens: 246_000,
      maxTokens: 256_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      profile,
    })
    assert.equal(over.action, 'micro')
    assert.equal(over.force, true)
  })

  it('decideCompactAction: open circuit breaker blocks discretionary actions but not the forced ceiling', () => {
    const profile = deriveCompactionProfile({ contextWindow: 1_000_000, billing: 'per-token', cache: 'exact-prefix' })
    const failures = { consecutiveFailures: 3, disabledUntilTurn: 10 }
    const discretionary = decideCompactAction({
      estimatedTokens: 650_000, maxTokens: 1_000_000, turn: 5, failures,
      providerProfile: { cacheType: 'exact-prefix', persistent: true }, profile,
    })
    assert.equal(discretionary.action, 'none')
    const forced = decideCompactAction({
      estimatedTokens: 960_000, maxTokens: 1_000_000, turn: 5, failures,
      providerProfile: { cacheType: 'exact-prefix', persistent: true }, profile,
    })
    assert.equal(forced.action, 'checkpoint')
    assert.equal(forced.force, true)
  })

  it('decideCompactTier threads the ceiling through end-to-end', () => {
    // 1M window, exact-prefix, hot cache: 710K tokens is past the 0.7 ceiling
    // and should recommend compaction even though the cache is hot.
    const d = decideCompactTier({
      estimatedTokens: 710_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.95,
    })
    assert.ok(d.tier >= 2)
    assert.equal(d.shouldCompact, true)

    // 690K, just under it, stays hands-off.
    const below = decideCompactTier({
      estimatedTokens: 690_000,
      maxTokens: 1_000_000,
      turn: 1,
      failures: { consecutiveFailures: 0 },
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
      recentHitRate: 0.95,
    })
    assert.equal(below.shouldCompact, false)
  })
})