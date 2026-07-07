import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enforceTurnReadBudget } from '../per-message-budget.js'

describe('enforceTurnReadBudget', () => {
  it('passes through results when under budget', () => {
    const results = [
      { toolUseId: '1', content: 'x'.repeat(1000), toolName: 'read_file' },
      { toolUseId: '2', content: 'y'.repeat(500), toolName: 'read_file' },
    ]
    // 200K window → budget = 200_000 * 0.15 * 4 = 120_000
    const enforced = enforceTurnReadBudget(results, 200_000)
    assert.equal(enforced[0]!.content, results[0]!.content)
    assert.equal(enforced[1]!.content, results[1]!.content)
  })

  it('passes through non-read_file tools unchanged', () => {
    const results = [
      { toolUseId: '1', content: 'x'.repeat(200_000), toolName: 'bash' },
    ]
    const enforced = enforceTurnReadBudget(results, 200_000)
    assert.equal(enforced[0]!.content, results[0]!.content)
  })

  it('truncates read_file results when cumulative chars exceed budget', () => {
    // Budget = 200_000 * 0.15 * 4 = 120_000
    const lines = Array.from({ length: 100 }, (_, i) => `line ${i}`)
    const bigContent = lines.join('\n')
    const results = [
      { toolUseId: '1', content: bigContent, toolName: 'read_file' },   // ~4K
      { toolUseId: '2', content: 'x'.repeat(130_000), toolName: 'read_file' }, // over budget
    ]
    const enforced = enforceTurnReadBudget(results, 200_000)
    // First result should be unchanged (under budget)
    assert.equal(enforced[0]!.content, bigContent)
    // Second result should be truncated (it has >20 lines of 'x' if split, but 'x'.repeat doesn't have newlines)
    // Actually, 'x'.repeat(130_000) is a single line — lines.length <= 20, so it passes through unchanged.
    // Let me use multiline content for the second result
    const multiLineContent = Array.from({ length: 50 }, () => 'x'.repeat(2600)).join('\n') // 50 lines, 130K chars
    const results2 = [
      { toolUseId: '1', content: bigContent, toolName: 'read_file' },
      { toolUseId: '2', content: multiLineContent, toolName: 'read_file' },
    ]
    const enforced2 = enforceTurnReadBudget(results2, 200_000)
    assert.equal(enforced2[0]!.content, bigContent)
    assert.ok(enforced2[1]!.content.length < multiLineContent.length, 'second result should be truncated')
    assert.match(enforced2[1]!.content, /turn read budget exceeded/)
  })

  it('returns results unchanged when contextWindow is 0 or negative', () => {
    const results = [
      { toolUseId: '1', content: 'x'.repeat(500_000), toolName: 'read_file' },
    ]
    const r0 = enforceTurnReadBudget(results, 0)
    assert.equal(r0[0]!.content, results[0]!.content)
    const rNeg = enforceTurnReadBudget(results, -1)
    assert.equal(rNeg[0]!.content, results[0]!.content)
  })

  it('truncates only read_file results, not other tools', () => {
    const multiLine = Array.from({ length: 50 }, () => 'x'.repeat(2600)).join('\n') // 50 lines, 130K chars
    const results = [
      { toolUseId: '1', content: 'x'.repeat(130_000), toolName: 'bash' },
      { toolUseId: '2', content: multiLine, toolName: 'read_file' },
    ]
    const enforced = enforceTurnReadBudget(results, 200_000)
    // bash result unchanged
    assert.equal(enforced[0]!.content.length, 130_000)
    // read_file truncated (bash doesn't count toward read budget)
    assert.ok(enforced[1]!.content.length < multiLine.length)
  })
})
