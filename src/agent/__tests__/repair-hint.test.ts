import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { RepairHintTracker } from '../repair-hint.js'

describe('RepairHintTracker', () => {
  let tracker: RepairHintTracker

  beforeEach(() => {
    tracker = new RepairHintTracker()
  })

  it('returns null when no failures recorded', () => {
    assert.equal(tracker.getHint(), null)
  })

  it('returns null after 1 failure (below threshold)', () => {
    tracker.recordFailure('bash', 'timeout')
    assert.equal(tracker.getHint(), null)
  })

  it('returns hint after 2 consecutive same-type failures', () => {
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    const hint = tracker.getHint()
    assert.ok(hint !== null)
    assert.ok(hint.includes('repair-hint'))
    assert.ok(hint.includes('shorter commands'))
  })

  it('returns null after 4+ failures (exhaustion limit)', () => {
    for (let i = 0; i < 4; i++) {
      tracker.recordFailure('bash', 'timeout')
    }
    assert.equal(tracker.getHint(), null)
  })

  it('clears failures on success', () => {
    tracker.recordFailure('bash', 'timeout')
    tracker.recordFailure('bash', 'timeout')
    tracker.recordSuccess('bash')
    assert.equal(tracker.getHint(), null)
  })

  // NEW: test new failure type hints
  it('returns permission_denied hint', () => {
    tracker.recordFailure('bash', 'permission_denied')
    tracker.recordFailure('bash', 'permission_denied')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('Check file permissions'))
  })

  it('returns context_window_exceeded hint', () => {
    tracker.recordFailure('bash', 'context_window_exceeded')
    tracker.recordFailure('bash', 'context_window_exceeded')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('/compact'))
  })

  it('returns api_error hint', () => {
    tracker.recordFailure('web_fetch', 'api_error')
    tracker.recordFailure('web_fetch', 'api_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('rate limit cooldown'))
  })

  it('returns syntax_error hint', () => {
    tracker.recordFailure('bash', 'syntax_error')
    tracker.recordFailure('bash', 'syntax_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('syntax error'))
  })

  it('returns format_error hint', () => {
    tracker.recordFailure('bash', 'format_error')
    tracker.recordFailure('bash', 'format_error')
    const hint = tracker.getHint()
    assert.ok(hint?.includes('malformed'))
  })
})
