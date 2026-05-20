import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideCompactTier, recordCompactFailure, recordCompactSuccess } from '../compact-policy.js'

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
