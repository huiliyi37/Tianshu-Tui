import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { suggestStrategyShift, type TrajectorySummary } from '../strategy-shift.js'

describe('suggestStrategyShift', () => {
  it('returns null when not in doom loop', () => {
    const result = suggestStrategyShift([], 'none')
    assert.equal(result, null)
  })

  it('suggests alternative approach for repeated edit failures', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
      { tool: 'edit_file', target: 'src/agent/loop.ts', status: 'failed', errorClass: 'type_error' },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.includes('edit_file'), `hint should mention the tool, got: ${result}`)
    assert.ok(result.includes('alternative') || result.includes('different'), `hint should suggest alternative, got: ${result}`)
  })

  it('suggests verification for repeated unverified writes', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'write_file', target: 'src/a.ts', status: 'success' },
      { tool: 'write_file', target: 'src/b.ts', status: 'success' },
      { tool: 'write_file', target: 'src/c.ts', status: 'success' },
      { tool: 'write_file', target: 'src/a.ts', status: 'success' },
    ]
    const result = suggestStrategyShift(trajectory, 'warn')
    assert.ok(result !== null)
    assert.ok(result.includes('verification') || result.includes('test') || result.includes('verify'), `should suggest verification, got: ${result}`)
  })

  it('suggests reading error output for transient failures', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
      { tool: 'bash', target: 'npm test', status: 'failed', errorClass: 'timeout' },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.includes('timeout') || result.includes('retry') || result.includes('different'), `should address timeout, got: ${result}`)
  })

  it('provides generic fallback for unknown patterns', () => {
    const trajectory: TrajectorySummary[] = [
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
      { tool: 'grep', target: 'pattern', status: 'failed', errorClass: undefined },
    ]
    const result = suggestStrategyShift(trajectory, 'blocked')
    assert.ok(result !== null)
    assert.ok(result.length > 20, 'fallback hint should be substantive')
  })
})
