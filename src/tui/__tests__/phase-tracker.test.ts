import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PhaseTracker } from '../phase-tracker.js'

describe('PhaseTracker', () => {
  it('starts in idle phase', () => {
    const pt = new PhaseTracker()
    assert.equal(pt.current(), 'idle')
  })

  it('stays idle after single tool use (debounce)', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'idle')
  })

  it('transitions to coding after 2 consecutive edit/write tools', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'idle')
    pt.onToolUse('write_file')
    assert.equal(pt.current(), 'coding')
  })

  it('transitions to testing after 2 consecutive run_tests', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('run_tests')
    assert.equal(pt.current(), 'idle')
    pt.onToolUse('run_tests')
    assert.equal(pt.current(), 'testing')
  })

  it('resets debounce counter on phase change', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')   // pendingPhase=coding, count=1
    pt.onToolUse('run_tests')   // pendingPhase=testing, count=1 (reset)
    pt.onToolUse('edit_file')   // pendingPhase=coding, count=1 (reset again)
    assert.equal(pt.current(), 'idle') // never reached 2
  })

  it('locks phase after debounce confirmed', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('grep'); pt.onToolUse('glob')
    assert.equal(pt.current(), 'searching') // confirmed after 2
    pt.onToolUse('edit_file') // stray coding tool, resets pending but doesn't change phase
    assert.equal(pt.current(), 'searching') // still searching
    pt.onToolUse('edit_file') // second coding, confirms the switch
    assert.equal(pt.current(), 'coding')
  })

  it('resets to idle on turn complete', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'coding')
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

  it('has immediate access to latest phase via snapshot during debounce', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('edit_file')
    pt.onToolUse('edit_file')
    assert.equal(pt.current(), 'coding')
    pt.onToolUse('read_file') // reset to searching count=1
    assert.equal(pt.current(), 'coding') // still coding until confirmed
    pt.onToolUse('read_file') // searching count=2, switch confirmed
    assert.equal(pt.current(), 'searching')
  })

  it('handles bash and delegate_task phase transitions with debounce', () => {
    const pt = new PhaseTracker()
    pt.onToolUse('bash')
    pt.onToolUse('bash')
    assert.equal(pt.current(), 'running')
    pt.onTurnComplete()
    pt.onToolUse('delegate_task')
    pt.onToolUse('delegate_task')
    assert.equal(pt.current(), 'delegating')
  })
})
