import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isStarSoulEnabled, shouldActivateStarSoul } from '../star-soul-gate.js'

describe('isStarSoulEnabled', () => {
  it('returns true by default (no env var)', () => {
    const saved = process.env.STAR_SOUL
    delete process.env.STAR_SOUL
    assert.equal(isStarSoulEnabled(), true)
    if (saved !== undefined) process.env.STAR_SOUL = saved
  })

  it('returns false when STAR_SOUL=0', () => {
    const saved = process.env.STAR_SOUL
    process.env.STAR_SOUL = '0'
    assert.equal(isStarSoulEnabled(), false)
    if (saved !== undefined) process.env.STAR_SOUL = saved
    else delete process.env.STAR_SOUL
  })

  it('returns true when STAR_SOUL=1', () => {
    const saved = process.env.STAR_SOUL
    process.env.STAR_SOUL = '1'
    assert.equal(isStarSoulEnabled(), true)
    if (saved !== undefined) process.env.STAR_SOUL = saved
    else delete process.env.STAR_SOUL
  })
})

describe('shouldActivateStarSoul', () => {
  it('returns false when confidence history is too short', () => {
    assert.equal(shouldActivateStarSoul([0.8, 0.9]), false)
  })

  it('returns true when confidence > 0.7 for N consecutive turns', () => {
    const history = Array(5).fill(0.75)
    assert.equal(shouldActivateStarSoul(history), true)
  })

  it('returns false when any turn drops below 0.7', () => {
    assert.equal(shouldActivateStarSoul([0.8, 0.9, 0.5, 0.8, 0.8]), false)
  })

  it('returns true when exactly at threshold', () => {
    const history = Array(5).fill(0.7)
    assert.equal(shouldActivateStarSoul(history), true)
  })

  it('respects STAR_SOUL=0 override regardless of confidence', () => {
    const saved = process.env.STAR_SOUL
    process.env.STAR_SOUL = '0'
    assert.equal(shouldActivateStarSoul(Array(5).fill(0.9)), false)
    if (saved !== undefined) process.env.STAR_SOUL = saved
    else delete process.env.STAR_SOUL
  })

  it('respects STAR_SOUL=1 override even with low confidence', () => {
    const saved = process.env.STAR_SOUL
    process.env.STAR_SOUL = '1'
    assert.equal(shouldActivateStarSoul([0.1]), true)
    if (saved !== undefined) process.env.STAR_SOUL = saved
    else delete process.env.STAR_SOUL
  })

  it('checks only the last N turns', () => {
    // Early turns were bad, but last 5 are good
    const history = [0.1, 0.2, 0.3, 0.4, 0.8, 0.8, 0.8, 0.8, 0.8]
    assert.equal(shouldActivateStarSoul(history), true)
  })
})
