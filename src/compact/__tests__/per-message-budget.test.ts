import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { perMessageToolResultBudget, PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS } from '../constants.js'

describe('perMessageToolResultBudget', () => {
  it('returns legacy constant for contextWindow=0', () => {
    assert.equal(perMessageToolResultBudget(0), PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS)
  })

  it('returns legacy constant for small windows where ×2 minChars < 120K', () => {
    // 64K → minChars=1200 → ×2=2400 < 120000 → floor to legacy 120K
    const budget = perMessageToolResultBudget(64_000)
    assert.equal(budget, PER_MESSAGE_TOOL_RESULT_BUDGET_CHARS)
  })

  it('returns 80_000 for 200K window (minChars=40000 → ×2)', () => {
    const budget = perMessageToolResultBudget(200_000)
    assert.ok(budget >= 80_000, `expected >= 80000, got ${budget}`)
    assert.ok(budget <= 150_000, `expected <= 150000, got ${budget}`)
  })

  it('returns 300_000 for 500K window (minChars=150000 → ×2)', () => {
    const budget = perMessageToolResultBudget(500_000)
    assert.equal(budget, 300_000)
  })

  it('caps at 300_000 for 1M window', () => {
    const budget = perMessageToolResultBudget(1_000_000)
    assert.equal(budget, 300_000)
  })
})
