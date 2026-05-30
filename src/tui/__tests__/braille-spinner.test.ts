import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brailleSpinnerFrame } from '../braille-spinner.js'

describe('brailleSpinnerFrame (S16)', () => {
  it('cycles through multiple distinct braille frames', () => {
    const frames = new Set([0, 1, 2, 3, 4, 5, 6, 7].map(brailleSpinnerFrame))
    assert.ok(frames.size >= 6, `expected >=6 distinct frames, got ${frames.size}`)
  })
  it('wraps around the frame index', () => {
    assert.equal(brailleSpinnerFrame(0), brailleSpinnerFrame(10_000_000))
  })
  it('returns a single braille char', () => {
    assert.match(brailleSpinnerFrame(3), /^[⠀-⣿]$/)
  })
})
