import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PhaseTracker } from '../phase-tracker.js'

describe('PhaseTracker', () => {
  it('starts in idle phase', () => {
    const pt = new PhaseTracker()
    assert.equal(pt.current(), 'idle')
  })

  it('transitions to coding on edit_file', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'coding')
  })

  it('transitions to testing on run_tests', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('run_tests')
    assert.equal(pt.current(), 'testing')
  })

  it('transitions to searching on read_file/grep/glob', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('grep')
    assert.equal(pt.current(), 'searching')
    pt.onToolUse('read_file')
    assert.equal(pt.current(), 'searching')
  })

  it('transitions to running on bash', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('bash')
    assert.equal(pt.current(), 'running')
  })

  it('transitions to delegating on delegate_task', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('delegate_task')
    assert.equal(pt.current(), 'delegating')
  })

  it('resets to idle on turn complete', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onTurnComplete()
    assert.equal(pt.current(), 'idle')
  })

  it('tracks step count within a turn', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('read_file')
    pt.onToolUse('edit_file')
    pt.onToolUse('run_tests')
    assert.equal(pt.stepCount(), 3)
  })

  it('resets step count on turn complete', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onToolUse('run_tests')
    pt.onTurnComplete()
    assert.equal(pt.stepCount(), 0)
  })

  it('records last action with target from onToolUse', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file', 'src/auth.ts')
    pt.onToolResult('edit_file', false)
    assert.deepEqual(pt.lastAction(), { tool: 'edit_file', target: 'src/auth.ts', success: true })
  })

  it('records last action failure', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('run_tests', 'auth.test.ts')
    pt.onToolResult('run_tests', true)
    assert.deepEqual(pt.lastAction(), { tool: 'run_tests', target: 'auth.test.ts', success: false })
  })

  it('falls back to tool name when no target provided', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onToolResult('edit_file', false)
    assert.deepEqual(pt.lastAction(), { tool: 'edit_file', target: 'edit_file', success: true })
  })
})
