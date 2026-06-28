import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brailleSpinnerFrame, circleSpinnerFrame } from '../braille-spinner.js'

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

describe('circleSpinnerFrame', () => {
  it('cycles through 4 moon-phase frames', () => {
    const frames = [0, 1, 2, 3, 4, 5, 6, 7].map(circleSpinnerFrame)
    const unique = new Set(frames)
    assert.equal(unique.size, 4, `expected 4 distinct frames, got ${unique.size}`)
    // verify the 4 specific glyphs
    for (const g of ['◐', '◓', '◑', '◒']) {
      assert.ok(unique.has(g), `expected ${g} in frames`)
    }
  })
  it('wraps around', () => {
    assert.equal(circleSpinnerFrame(0), circleSpinnerFrame(4))
    assert.equal(circleSpinnerFrame(1), circleSpinnerFrame(5))
  })
})
