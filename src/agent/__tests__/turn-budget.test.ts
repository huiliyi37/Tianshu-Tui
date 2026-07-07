import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { createTurnBudget, BASE_BUDGET_TOKENS, PRESSURE_BUDGET_TOKENS } from '../turn-budget.js'

describe('TurnBudget', () => {
  it('uses base budget when RSS ratio is low', () => {
    const budget = createTurnBudget(0.3)
    assert.strictEqual(budget.maxTokensPerTurn, BASE_BUDGET_TOKENS)
  })

  it('uses pressure budget when RSS ratio >= 0.7', () => {
    const budget = createTurnBudget(0.75)
    assert.strictEqual(budget.maxTokensPerTurn, PRESSURE_BUDGET_TOKENS)
  })

  it('uses zero budget when RSS ratio >= 0.85', () => {
    const budget = createTurnBudget(0.9)
    assert.strictEqual(budget.maxTokensPerTurn, 0)
  })

  it('tracks consumed tokens', () => {
    const budget = createTurnBudget(0.3)
    budget.consume(10_000)
    assert.strictEqual(budget.usedTokens, 10_000)
    assert.ok(!budget.isExhausted())
  })

  it('reports exhausted when budget exceeded', () => {
    const budget = createTurnBudget(0.3)
    budget.consume(BASE_BUDGET_TOKENS + 1)
    assert.ok(budget.isExhausted())
  })

  it('resets to zero', () => {
    const budget = createTurnBudget(0.5)
    budget.consume(20_000)
    budget.reset()
    assert.strictEqual(budget.usedTokens, 0)
    assert.ok(!budget.isExhausted())
  })
})
