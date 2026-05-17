import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { FluencyTracker } from '../fluency-hook.js'

// ---------------------------------------------------------------------------
// FluencyTracker — integration tests
// ---------------------------------------------------------------------------

describe('FluencyTracker', () => {
  it('starts with normal visibility', () => {
    const tracker = new FluencyTracker()
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'normal')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
    assert.equal(policy.staleMessage, undefined)
  })

  it('enters quiet after 4 consecutive routine tools (read_file, grep, glob)', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'grep', isError: false, resultLength: 200 })
    tracker.recordToolResult({ name: 'glob', isError: false, resultLength: 50 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 80 })

    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'quiet')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 500)
  })

  it('resets routine on error tool result', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'grep', isError: false, resultLength: 200 })
    tracker.recordToolResult({ name: 'glob', isError: false, resultLength: 50 })
    // still 3 — should be normal
    assert.equal(tracker.getPolicy().visibility, 'normal')

    // error resets the streak, so our already-recorded 3rd tool actually stays at 3
    // but now we record an error tool after — let's build up first
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 80 })
    assert.equal(tracker.getPolicy().visibility, 'quiet')

    // record error tool — routine breaks back to 0
    tracker.recordToolResult({ name: 'bash', isError: true, resultLength: 0 })
    assert.equal(tracker.getPolicy().visibility, 'inspect') // error → inspect

    // now routine count is 0, so next recording without error should be normal
    // (need a new tracker or wait for the error signal to clear)
    // error is sticky via lastIsError — use onTurnComplete to reset
  })

  it('breaks routine streak when a non-routine tool result is recorded', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'grep', isError: false, resultLength: 200 })
    tracker.recordToolResult({ name: 'glob', isError: false, resultLength: 50 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 80 })
    assert.equal(tracker.getPolicy().visibility, 'quiet')

    // A non-routine tool breaks the streak
    tracker.recordToolResult({ name: 'bash', isError: false, resultLength: 10 })
    assert.equal(tracker.getPolicy().visibility, 'normal')
  })

  it('detects stale after silence (updateSilence(20000))', () => {
    const tracker = new FluencyTracker()
    tracker.updateSilence(20_000)
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
    assert.ok(policy.staleMessage !== undefined && policy.staleMessage.includes('s'),
      `expected staleMessage to include 's', got ${policy.staleMessage}`)
  })

  it('reports inspect with coalescing for large tool results', () => {
    const tracker = new FluencyTracker()
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 60_000 })
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 1000)
  })

  it('reports stress under high context pressure (0.92)', () => {
    const tracker = new FluencyTracker()
    tracker.setContextPressure(0.92)
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'stress')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 1000 + Math.round(0.92 * 2000))
  })

  it('resets on turn complete', () => {
    const tracker = new FluencyTracker()

    // Set up some state
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    assert.equal(tracker.getPolicy().visibility, 'quiet')

    // Note: contextPressure is NOT reset by onTurnComplete — it's an external signal
    tracker.setPhase('thinking')

    // Reset
    tracker.onTurnComplete()
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'normal')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
  })

  it('classifies routine tool names as routine', () => {
    const tracker = new FluencyTracker()
    const routineNames = ['read_file', 'grep', 'glob', 'inspect_project', 'repo_map', 'related_tests', 'recall', 'diff']
    for (const name of routineNames) {
      assert.equal(tracker.isRoutineTool(name, false), true, `expected ${name} to be routine`)
    }
  })

  it('classifies errors as non-routine regardless of tool name', () => {
    const tracker = new FluencyTracker()
    // Routine tool with error → not routine
    assert.equal(tracker.isRoutineTool('read_file', true), false)
    assert.equal(tracker.isRoutineTool('grep', true), false)
    assert.equal(tracker.isRoutineTool('glob', true), false)
    // Non-routine tool with error → not routine
    assert.equal(tracker.isRoutineTool('bash', true), false)
    assert.equal(tracker.isRoutineTool('edit_file', true), false)
  })

  it('classifies edit_file, bash, write_file as non-routine', () => {
    const tracker = new FluencyTracker()
    assert.equal(tracker.isRoutineTool('edit_file', false), false)
    assert.equal(tracker.isRoutineTool('bash', false), false)
    assert.equal(tracker.isRoutineTool('write_file', false), false)
  })

  it('recordApproval resets routine and sets approval flag (visibility=inspect)', () => {
    const tracker = new FluencyTracker()

    // Build up routine count
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    tracker.recordToolResult({ name: 'grep', isError: false, resultLength: 200 })
    tracker.recordToolResult({ name: 'glob', isError: false, resultLength: 50 })
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 80 })

    // After 4 routines, policy says quiet
    assert.equal(tracker.getPolicy().visibility, 'quiet')

    // Approval resets routine and sets isApproval
    tracker.recordApproval()
    const policy = tracker.getPolicy()
    assert.equal(policy.visibility, 'inspect') // isApproval → inspect
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)

    // Routine count should be reset — next tool starts fresh
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })
    assert.equal(tracker.getPolicy().visibility, 'normal')
  })

  it('setPhase updates phase and resets lastEventAt', () => {
    const tracker = new FluencyTracker()

    // Record a tool so lastEventAt is recent, then simulate age
    tracker.recordToolResult({ name: 'read_file', isError: false, resultLength: 100 })

    // Call setPhase — this updates the phase and resets lastEventAt to now
    tracker.setPhase('thinking')
    const policy = tracker.getPolicy()
    // Since phase changed and lastEventAt was just bumped, there's no silence,
    // no errors, no routine, no pressure — so visibility should be normal
    assert.equal(policy.visibility, 'normal')

    // Verify the phase change is reflected in stale detection
    // After setPhase to thinking, need 30s+ for info tier
    tracker.updateSilence(35_000)
    const stalePolicy = tracker.getPolicy()
    assert.equal(stalePolicy.visibility, 'inspect')
    assert.ok(stalePolicy.staleMessage !== undefined)
  })
})
