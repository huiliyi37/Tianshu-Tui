import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { progressiveTimeout, DEFAULT_WORKER_BUDGET_MS } from '../timeout-ladder.js'

describe('timeout ladder — tiered progressive curve', () => {
  it('returns 120s for cold open (turn 0-1)', () => {
    assert.equal(progressiveTimeout(0), 120_000)
    assert.equal(progressiveTimeout(1), 120_000)
  })

  it('returns 240s for warming (turn 2-4)', () => {
    assert.equal(progressiveTimeout(2), 240_000)
    assert.equal(progressiveTimeout(3), 240_000)
    assert.equal(progressiveTimeout(4), 240_000)
  })

  it('returns 480s for mature (turn 5+)', () => {
    assert.equal(progressiveTimeout(5), 480_000)
    assert.equal(progressiveTimeout(100), 480_000)
  })

  it('defaults to mature (480s) when turn is unknown', () => {
    assert.equal(progressiveTimeout(), 480_000)
    assert.equal(progressiveTimeout(undefined), 480_000)
  })

  it('sequence is monotonically non-decreasing', () => {
    let prev = 0
    for (let turn = 0; turn <= 20; turn++) {
      const v = progressiveTimeout(turn)
      assert.ok(v >= prev, `turn ${turn}: ${v} < prev ${prev}`)
      prev = v
    }
  })

  it('default worker budget is the far backstop (≥ mature tool timeout)', () => {
    assert.ok(DEFAULT_WORKER_BUDGET_MS >= progressiveTimeout(100))
  })
})
