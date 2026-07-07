import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { toolTypeBudgets, getToolBudget } from '../constants.js'

describe('toolTypeBudgets', () => {
  it('returns budgets for known tool types', () => {
    const budgets = toolTypeBudgets(200_000)
    assert.ok(budgets['grep'])
    assert.ok(budgets['read_file'])
    assert.ok(budgets['bash'])
    assert.ok(budgets['default'])
  })

  it('grep has fixed budget on small windows, scales on large', () => {
    const small = toolTypeBudgets(64_000)
    const large = toolTypeBudgets(1_000_000)
    assert.equal(small['grep']!.perCall, 2_000)
    assert.equal(small['grep']!.summarizeAfter, 4_000)
    // 1M: perCall = min(1M*0.004, 8K) = 4K, summarizeAfter = min(1M*0.008, 16K) = 8K
    assert.equal(large['grep']!.perCall, 4_000)
    assert.equal(large['grep']!.summarizeAfter, 8_000)
  })

  it('read_file budget scales with window up to cap', () => {
    const b64k = toolTypeBudgets(64_000)
    const b200k = toolTypeBudgets(200_000)
    const b1m = toolTypeBudgets(1_000_000)

    assert.equal(b64k['read_file']!.perCall, 6_400)
    assert.equal(b200k['read_file']!.perCall, 20_000)
    assert.equal(b1m['read_file']!.perCall, 20_000)
  })
})

describe('getToolBudget', () => {
  it('returns specific budget for known tools', () => {
    const budget = getToolBudget('grep', 200_000)
    // 200K scales: min(200K*0.004, 8K) = 800
    assert.equal(budget.perCall, 800)
  })

  it('returns default budget for unknown tools', () => {
    const budget = getToolBudget('unknown_tool', 200_000)
    assert.equal(budget.perCall, 5_000)
  })
})
