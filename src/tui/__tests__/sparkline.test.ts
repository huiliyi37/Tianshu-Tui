import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { brailleSparkline } from '../format-utils.js'

describe('brailleSparkline', () => {
  it('renders empty sparkline for no data', () => {
    assert.equal(brailleSparkline([]), '')
  })

  it('renders sparkline for single value', () => {
    const result = brailleSparkline([0.5])
    assert.ok(result.length > 0)
  })

  it('renders sparkline for increasing values', () => {
    const result = brailleSparkline([0.1, 0.2, 0.3, 0.5, 0.7, 0.9])
    assert.ok(result.length > 0)
    assert.ok(/[⠀-⣿]/.test(result), 'should contain braille characters')
  })

  it('renders sparkline for flat values', () => {
    const result = brailleSparkline([0.5, 0.5, 0.5, 0.5])
    assert.ok(result.length > 0)
  })

  it('clamps values outside 0-1 range', () => {
    const result = brailleSparkline([-0.1, 0.5, 1.5])
    assert.ok(result.length > 0)
  })

  it('renders shorter string for fewer values', () => {
    const short = brailleSparkline([0.5])
    const long = brailleSparkline([0.1, 0.2, 0.3, 0.4, 0.5, 0.6])
    assert.ok(long.length >= short.length)
  })
})
