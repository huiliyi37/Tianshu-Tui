import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compactPolicyRatios, compactProviderStrategy, compactThresholds } from '../constants.js'

describe('compactThresholds', () => {
  it('preserves numeric defaults for a 128K window', () => {
    const thresholds = compactThresholds(128_000)

    assert.equal(thresholds.autoThreshold, 102_400)
    assert.equal(thresholds.autoFloor, 76_800)
    assert.equal(thresholds.toolResultMaxTokens, 38_400)
  })

  it('raises only the large-window tool result cap for numeric calls', () => {
    const thresholds = compactThresholds(1_000_000)

    assert.equal(thresholds.autoThreshold, 800_000)
    assert.equal(thresholds.autoFloor, 500_000)
    assert.equal(thresholds.toolResultMaxTokens, 200_000)
  })

  it('uses cache-preserving thresholds for persistent exact-prefix providers', () => {
    const thresholds = compactThresholds({
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'exact-prefix', persistent: true },
    })

    assert.equal(compactProviderStrategy({ cacheType: 'exact-prefix', persistent: true }), 'cache-preserving')
    assert.deepEqual(compactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }), {
      watch: 0.72,
      compact: 0.86,
      reactive: 0.92,
      ceiling: 0.95,
    })
    assert.equal(thresholds.autoThreshold, 920_000)
    assert.equal(thresholds.autoFloor, 500_000)
    assert.equal(thresholds.toolResultMaxTokens, 200_000)
  })

  it('uses aggressive thresholds for no-cache providers', () => {
    const thresholds = compactThresholds({
      contextWindow: 1_000_000,
      providerProfile: { cacheType: 'none', persistent: false },
    })

    assert.equal(compactProviderStrategy({ cacheType: 'none', persistent: false }), 'aggressive')
    assert.equal(thresholds.autoThreshold, 840_000)
    assert.equal(thresholds.autoFloor, 500_000)
    assert.equal(thresholds.toolResultMaxTokens, 200_000)
  })

  it('scales down to 8K window', () => {
    const thresholds = compactThresholds(8_000)

    assert.equal(thresholds.autoThreshold, 6_400)
    assert.equal(thresholds.autoFloor, 4_800)
    assert.equal(thresholds.toolResultMaxTokens, 2_400)
  })
})
