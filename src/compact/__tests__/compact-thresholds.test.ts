import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { compactThresholds } from '../constants.js'

describe('compactThresholds', () => {
  it('scales to 128K window', () => {
    const thresholds = compactThresholds(128_000)

    assert.equal(thresholds.autoThreshold, 102_400)
    assert.equal(thresholds.autoFloor, 76_800)
    assert.equal(thresholds.toolResultMaxTokens, 38_400)
  })

  it('preserves DeepSeek 1M defaults', () => {
    const thresholds = compactThresholds(1_000_000)

    assert.equal(thresholds.autoThreshold, 800_000)
    assert.equal(thresholds.autoFloor, 500_000)
    assert.equal(thresholds.toolResultMaxTokens, 100_000)
  })

  it('scales down to 8K window', () => {
    const thresholds = compactThresholds(8_000)

    assert.equal(thresholds.autoThreshold, 6_400)
    assert.equal(thresholds.autoFloor, 4_800)
    assert.equal(thresholds.toolResultMaxTokens, 2_400)
  })
})
