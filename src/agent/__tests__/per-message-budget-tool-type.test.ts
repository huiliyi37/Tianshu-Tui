import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { enforceToolTypeBudgets } from '../per-message-budget.js'

describe('enforceToolTypeBudgets', () => {
  const CTX_200K = 200_000

  it('passes through small results unchanged', () => {
    const results = [
      { toolUseId: '1', content: 'small result', toolName: 'grep' },
      { toolUseId: '2', content: 'another small', toolName: 'bash' },
    ]
    const enforced = enforceToolTypeBudgets(results, CTX_200K)
    assert.equal(enforced[0]!.content, 'small result')
    assert.equal(enforced[1]!.content, 'another small')
  })

  it('truncates grep results exceeding perCall budget', () => {
    const lines = Array.from({ length: 500 }, (_, i) => `src/file${i}.ts:${i}: const fooBarBaz = someVeryLongVariableName_${i}`)
    const bigContent = lines.join('\n')
    assert.ok(bigContent.length > 2_000 * 4, 'content must exceed 2000 token budget')
    const results = [
      { toolUseId: '1', content: bigContent, toolName: 'grep' },
    ]
    const enforced = enforceToolTypeBudgets(results, CTX_200K)
    assert.ok(enforced[0]!.content.length < bigContent.length, 'should truncate large grep result')
  })

  it('summarizes when cumulative exceeds summarizeAfter threshold', () => {
    const results = Array.from({ length: 8 }, (_, i) => ({
      toolUseId: `g${i}`,
      content: 'x'.repeat(2500),
      toolName: 'grep',
    }))
    const enforced = enforceToolTypeBudgets(results, CTX_200K)
    const summarized = enforced.filter(r => r.content.includes('budget-summarized'))
    assert.ok(summarized.length > 0, 'should have some summarized results')
  })

  it('tracks cumulative separately per tool type', () => {
    const grepResults = Array.from({ length: 4 }, (_, i) => ({
      toolUseId: `g${i}`,
      content: 'g'.repeat(2500),
      toolName: 'grep',
    }))
    const bashResults = Array.from({ length: 2 }, (_, i) => ({
      toolUseId: `b${i}`,
      content: 'b'.repeat(2500),
      toolName: 'bash',
    }))
    const interleaved = [...grepResults, ...bashResults]
    const enforced = enforceToolTypeBudgets(interleaved, CTX_200K)
    const bashSummarized = enforced
      .filter(r => r.toolName === 'bash')
      .filter(r => r.content.includes('budget-summarized'))
    assert.equal(bashSummarized.length, 0, 'bash should not be summarized with only 2 calls')
  })

  it('returns results unchanged for zero/negative contextWindow', () => {
    const results = [
      { toolUseId: '1', content: 'x'.repeat(50_000), toolName: 'grep' },
    ]
    assert.deepEqual(enforceToolTypeBudgets(results, 0), results)
    assert.deepEqual(enforceToolTypeBudgets(results, -1), results)
  })

  it('scales read_file budget with context window', () => {
    const small = 64_000
    const large = 1_000_000
    const bigRead = 'x'.repeat(30_000)
    const results = [{ toolUseId: '1', content: bigRead, toolName: 'read_file' }]

    const smallEnforced = enforceToolTypeBudgets(results, small)
    const largeEnforced = enforceToolTypeBudgets(results, large)

    assert.ok(
      smallEnforced[0]!.content.length <= largeEnforced[0]!.content.length,
      'small window should truncate more aggressively',
    )
  })
})
