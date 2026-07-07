import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isStarSoulEnabled } from '../star-soul-gate.js'

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
