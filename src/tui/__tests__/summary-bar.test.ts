import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatSummaryLine1, formatSummaryLine2, formatSummaryLine3 } from '../format-utils.js'
import type { SummaryState } from '../summary-state.js'

describe('SummaryBar formatting', () => {
  const state: SummaryState = {
    task: 'refactor auth middleware',
    phase: 'testing',
    stepCount: 3,
    totalSteps: 5,
    contextPct: 0.65,
    elapsedMs: 252000,
    lastAction: { tool: 'edit_file', target: 'src/auth/middleware.ts', success: true },
    risk: 'none',
  }

  it('formats line 1 with task, phase, context, elapsed', () => {
    const line = formatSummaryLine1(state, 0)
    assert.ok(line.includes('refactor auth middleware'))
    assert.ok(line.includes('testing'))
    assert.ok(line.includes('3/5'))
    assert.ok(line.includes('65%'))
    assert.ok(line.includes('4m'))
  })

  it('formats line 2 with last action', () => {
    const line = formatSummaryLine2(state)
    assert.ok(line.includes('edit_file'))
    assert.ok(line.includes('middleware.ts'))
    assert.ok(line.includes('✓'))
  })

  it('formats line 2 with failure indicator', () => {
    const failState = { ...state, lastAction: { tool: 'run_tests', target: 'auth.test.ts', success: false } }
    const line = formatSummaryLine2(failState)
    assert.ok(line.includes('✗'))
  })

  it('formats line 3 with risk none', () => {
    const line = formatSummaryLine3(state)
    assert.ok(line.includes('risk: none'))
  })

  it('formats line 3 with high risk', () => {
    const highRisk = { ...state, risk: 'high' as const }
    const line = formatSummaryLine3(highRisk)
    assert.ok(line.includes('risk: high'))
  })

  it('formats line 3 with compact event', () => {
    const compactState = { ...state, compactEvent: { beforeTokens: 180000, afterTokens: 45000 } }
    const line = formatSummaryLine3(compactState)
    assert.ok(line.includes('180k→45k'))
    assert.ok(line.includes('⚡'))
  })

  it('formats line 3 with approval needed', () => {
    const approvalState = { ...state, approvalNeeded: { tool: 'bash', target: 'rm -rf /tmp' } }
    const line = formatSummaryLine3(approvalState)
    assert.ok(line.includes('APPROVAL'))
    assert.ok(line.includes('bash'))
  })

  it('approval takes priority over compact event', () => {
    const both = { ...state, approvalNeeded: { tool: 'bash', target: 'x' }, compactEvent: { beforeTokens: 100000, afterTokens: 50000 } }
    const line = formatSummaryLine3(both)
    assert.ok(line.includes('APPROVAL'))
    assert.ok(!line.includes('compact'))
  })

  it('truncates long task names', () => {
    const longTask = { ...state, task: 'a very long task description that exceeds thirty characters limit' }
    const line = formatSummaryLine1(longTask, 0)
    assert.ok(line.includes('…'))
  })

  it('handles idle phase with no last action', () => {
    const idle: SummaryState = { task: '', phase: 'idle', stepCount: 0, totalSteps: 0, contextPct: 0.1, elapsedMs: 0, lastAction: null, risk: 'none' }
    const line2 = formatSummaryLine2(idle)
    assert.ok(line2.includes('waiting'))
  })
})
