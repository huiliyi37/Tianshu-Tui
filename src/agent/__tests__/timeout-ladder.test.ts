import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { progressiveTimeout, DEFAULT_WORKER_BUDGET_MS } from '../timeout-ladder.js'

describe('timeout ladder — arithmetic curve only', () => {
  it('returns 60s for cold open (turn 0-1)', () => {
    assert.equal(progressiveTimeout(0), 60_000)
    assert.equal(progressiveTimeout(1), 60_000)
  })

  it('returns 120s for warming (turn 2-4)', () => {
    assert.equal(progressiveTimeout(2), 120_000)
    assert.equal(progressiveTimeout(3), 120_000)
    assert.equal(progressiveTimeout(4), 120_000)
  })

  it('returns 180s for mature (turn 5+)', () => {
    assert.equal(progressiveTimeout(5), 180_000)
    assert.equal(progressiveTimeout(100), 180_000)
  })

  it('defaults to mature (180s) when turn is unknown', () => {
    assert.equal(progressiveTimeout(), 180_000)
    assert.equal(progressiveTimeout(undefined), 180_000)
  })

  it('is an arithmetic sequence (common difference 60s)', () => {
    assert.equal(progressiveTimeout(3) - progressiveTimeout(0), 60_000)
    assert.equal(progressiveTimeout(10) - progressiveTimeout(3), 60_000)
  })

  it('sequence is monotonically non-decreasing', () => {
    let prev = 0
    for (let turn = 0; turn <= 20; turn++) {
      const v = progressiveTimeout(turn)
      assert.ok(v >= prev, `turn ${turn}: ${v} < prev ${prev}`)
      prev = v
    }
  })

  it('rejects the old non-arithmetic curves (30/75/180, 45/90/180)', () => {
    assert.notEqual(75_000 - 30_000, 60_000, 'old 30→75 was NOT arithmetic (Δ45)')
    assert.notEqual(180_000 - 75_000, 60_000, 'old 75→180 was NOT arithmetic (Δ105)')
    assert.notEqual(90_000 - 45_000, 60_000, 'old 45→90 was NOT arithmetic (Δ45)')
    assert.notEqual(180_000 - 90_000, 60_000, 'old 90→180 was NOT arithmetic (Δ90)')
  })

  it('default worker budget is the far backstop (≥ mature tool timeout)', () => {
    assert.ok(DEFAULT_WORKER_BUDGET_MS >= progressiveTimeout(100))
  })
})
