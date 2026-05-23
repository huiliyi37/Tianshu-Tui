import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { adaptiveCompactPolicyRatios } from '../../compact/constants.js'

describe('adaptiveCompactPolicyRatios', () => {
  it('shifts ratios up when cache hit rate is high', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }, 0.9)
    assert.ok(ratios.watch > 0.72)
    assert.ok(ratios.compact > 0.86)
  })

  it('shifts ratios down when cache hit rate is low', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }, 0.2)
    assert.ok(ratios.watch < 0.72)
    assert.ok(ratios.compact < 0.86)
  })

  it('returns base ratios for neutral hit rate', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }, 0.6)
    assert.equal(ratios.watch, 0.72)
    assert.equal(ratios.compact, 0.86)
  })

  it('clamps ratios within safe bounds', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }, 0.99)
    assert.ok(ratios.watch <= 0.90)
    assert.ok(ratios.compact <= 0.93)
    assert.ok(ratios.reactive <= 0.95)
    assert.equal(ratios.ceiling, 0.95)
  })

  it('returns base for null hit rate', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'exact-prefix', persistent: true }, null)
    assert.equal(ratios.watch, 0.72)
    assert.equal(ratios.compact, 0.86)
  })

  it('works for no-cache providers', () => {
    const ratios = adaptiveCompactPolicyRatios({ cacheType: 'none', persistent: false }, 0.9)
    assert.ok(ratios.watch > 0.5)
  })
})
