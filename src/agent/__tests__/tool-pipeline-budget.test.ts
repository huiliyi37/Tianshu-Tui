import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enforcePerMessageBudget } from '../per-message-budget.js'

describe('enforcePerMessageBudget', () => {
  it('returns results unchanged when under budget', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(1000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(2000), toolName: 'read_file' },
    ]
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.equal(enforced[0]!.content, results[0]!.content)
    assert.equal(enforced[1]!.content, results[1]!.content)
  })

  it('replaces largest results first when over budget', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(50_000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(80_000), toolName: 'bash' },
      { toolUseId: 'c', content: 'x'.repeat(10_000), toolName: 'read_file' },
    ]
    // Total = 140K, budget = 120K. Must evict 'b' (largest evictable, 80K).
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.ok(enforced[1]!.content.startsWith('[budget-evicted:'))
    assert.equal(enforced[0]!.content, results[0]!.content)
    assert.equal(enforced[2]!.content, results[2]!.content)
  })

  it('evicts multiple results if needed', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(60_000), toolName: 'grep' },
      { toolUseId: 'b', content: 'x'.repeat(50_000), toolName: 'bash' },
      { toolUseId: 'c', content: 'x'.repeat(40_000), toolName: 'grep' },
    ]
    // Total = 150K, budget = 80K. Must evict 'a' (60K) + 'b' (50K).
    const enforced = enforcePerMessageBudget(results, 80_000)
    assert.ok(enforced[0]!.content.startsWith('[budget-evicted:'))
    assert.ok(enforced[1]!.content.startsWith('[budget-evicted:'))
    assert.equal(enforced[2]!.content, results[2]!.content)
  })

  it('never evicts read_file results', () => {
    const results = [
      { toolUseId: 'a', content: 'x'.repeat(100_000), toolName: 'read_file' },
      { toolUseId: 'b', content: 'x'.repeat(50_000), toolName: 'bash' },
    ]
    // Total = 150K, budget = 120K. 'a' is read_file (protected), evict 'b'.
    const enforced = enforcePerMessageBudget(results, 120_000)
    assert.equal(enforced[0]!.content, results[0]!.content)
    assert.ok(enforced[1]!.content.startsWith('[budget-evicted:'))
  })
})
