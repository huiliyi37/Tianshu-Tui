import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeCompactAttribution,
  isLowPressureRewrite,
  LOW_PRESSURE_REWRITE_RATIO,
} from '../compact-attribution.js'

describe('computeCompactAttribution', () => {
  it('records before/after/reclaimed/pre-ratio for a normal rewrite', () => {
    const attr = computeCompactAttribution(600_000, 200_000, 1_000_000)
    assert.equal(attr.compactTokensBefore, 600_000)
    assert.equal(attr.compactTokensAfter, 200_000)
    assert.equal(attr.compactReclaimed, 400_000)
    assert.equal(attr.compactPreRatio, 0.6)
  })

  it('clamps reclaimed at 0 when the window grew (no real reclaim)', () => {
    const attr = computeCompactAttribution(100_000, 120_000, 1_000_000)
    assert.equal(attr.compactReclaimed, 0)
    assert.equal(attr.compactTokensAfter, 120_000)
  })

  it('omits before/reclaimed/pre-ratio on the first turn (no baseline)', () => {
    const attr = computeCompactAttribution(0, 50_000, 1_000_000)
    assert.equal(attr.compactTokensAfter, 50_000)
    assert.equal(attr.compactTokensBefore, undefined)
    assert.equal(attr.compactReclaimed, undefined)
    assert.equal(attr.compactPreRatio, undefined)
  })

  it('omits pre-ratio when the context window is unknown', () => {
    const attr = computeCompactAttribution(600_000, 200_000, 0)
    assert.equal(attr.compactPreRatio, undefined)
    assert.equal(attr.compactReclaimed, 400_000)
  })

  it('rounds pre-ratio to 3 decimals', () => {
    const attr = computeCompactAttribution(123_456, 1, 1_000_000)
    assert.equal(attr.compactPreRatio, 0.123)
  })
})

describe('isLowPressureRewrite', () => {
  it('flags rewrites below the low-pressure ratio', () => {
    assert.equal(isLowPressureRewrite(0.3), true)
    assert.equal(isLowPressureRewrite(LOW_PRESSURE_REWRITE_RATIO - 0.01), true)
  })

  it('does not flag rewrites at or above the ratio', () => {
    assert.equal(isLowPressureRewrite(LOW_PRESSURE_REWRITE_RATIO), false)
    assert.equal(isLowPressureRewrite(0.9), false)
  })

  it('does not flag when pre-ratio is unknown', () => {
    assert.equal(isLowPressureRewrite(undefined), false)
  })
})
