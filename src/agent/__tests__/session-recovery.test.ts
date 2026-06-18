import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideStartupSession, RESUME_FRESHNESS_MS, type StartupDecisionInput } from '../session-recovery.js'

const CWD = '/proj/a'

function input(overrides: Partial<StartupDecisionInput> = {}): StartupDecisionInput {
  return {
    lastSessionId: 'sess-1',
    now: Date.now(),
    freshnessMs: RESUME_FRESHNESS_MS,
    forceNew: false,
    resume: false,
    disableAutoResume: false,
    currentCwd: CWD,
    // Default: a crashed-mid-flight session in the same cwd (active, no cleanExit).
    load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD, cleanExit: false }),
    ...overrides,
  }
}

describe('session-recovery: decideStartupSession (R1 fresh-by-default)', () => {
  it('default startup after a clean exit mints a fresh session', () => {
    const d = decideStartupSession(input({
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD, cleanExit: true }),
    }))
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('default startup with no clean-exit marker but completed status is fresh', () => {
    for (const status of ['completed', 'archived'] as const) {
      const d = decideStartupSession(input({
        load: () => ({ hasContent: true, status, updatedAt: Date.now(), cwd: CWD }),
      }))
      assert.equal(d.resumed, false, `status=${status}`)
    }
  })

  it('mints new when there is no previous session', () => {
    const d = decideStartupSession(input({ lastSessionId: null }))
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('mints new when previous session has no replayable content', () => {
    const d = decideStartupSession(input({
      load: () => ({ hasContent: false, status: 'active', cwd: CWD }),
    }))
    assert.equal(d.resumed, false)
  })

  it('explicit --continue/--resume returns to the last session regardless of clean exit', () => {
    const d = decideStartupSession(input({
      resume: true,
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD, cleanExit: true }),
    }))
    assert.equal(d.resumed, true)
    assert.equal(d.sessionId, 'sess-1')
  })

  it('explicit resume honors a completed session too', () => {
    const d = decideStartupSession(input({
      resume: true,
      load: () => ({ hasContent: true, status: 'completed', updatedAt: Date.now(), cwd: CWD, cleanExit: true }),
    }))
    assert.equal(d.resumed, true)
    assert.equal(d.sessionId, 'sess-1')
  })

  it('no longer silently resumes active sessions — default is always fresh', () => {
    const d = decideStartupSession(input())
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('never resumes a session belonging to another cwd (even with --continue)', () => {
    const d = decideStartupSession(input({
      resume: true,
      currentCwd: '/proj/b',
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: '/proj/a', cleanExit: false }),
    }))
    assert.equal(d.resumed, false)
    assert.match(d.reason, /another cwd/)
  })

  it('does not crash-resume sessions beyond the freshness window', () => {
    const d = decideStartupSession(input({
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now() - RESUME_FRESHNESS_MS - 1, cwd: CWD, cleanExit: false }),
    }))
    assert.equal(d.resumed, false)
  })

  it('RIVET_NEW_SESSION (forceNew) always mints fresh, even with crash state', () => {
    const d = decideStartupSession(input({ forceNew: true }))
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('RIVET_NO_AUTO_RESUME still allows explicit --continue to work', () => {
    const suppressed = decideStartupSession(input({ disableAutoResume: true }))
    assert.equal(suppressed.resumed, false)

    const explicit = decideStartupSession(input({ disableAutoResume: true, resume: true }))
    assert.equal(explicit.resumed, true)
    assert.equal(explicit.sessionId, 'sess-1')
  })

  it('mints new when the previous session is unreadable', () => {
    const d = decideStartupSession(input({ load: () => null }))
    assert.equal(d.resumed, false)
  })

  it('legacy sessions without cwd field: not auto-resumed', () => {
    const d = decideStartupSession(input({
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cleanExit: false }),
    }))
    assert.equal(d.resumed, false)
  })
})

describe('session-recovery: decideStartupSession resumeSessionId (--resume <id>)', () => {
  it('resumes the requested session id, ignoring lastSessionId', () => {
    const d = decideStartupSession(input({
      lastSessionId: 'sess-1',
      resumeSessionId: 'target-99',
      load: (id) => id === 'target-99'
        ? { hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD, cleanExit: true }
        : null,
    }))
    assert.equal(d.resumed, true)
    assert.equal(d.sessionId, 'target-99')
    assert.match(d.reason, /--resume <id>/)
  })

  it('takes precedence over the bare resume flag', () => {
    const d = decideStartupSession(input({
      resume: true,
      resumeSessionId: 'target-99',
      load: (id) => id === 'target-99'
        ? { hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD }
        : { hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD },
    }))
    assert.equal(d.sessionId, 'target-99')
  })

  it('mints fresh when the requested session is unreadable', () => {
    const d = decideStartupSession(input({
      resumeSessionId: 'missing',
      load: () => null,
    }))
    assert.equal(d.resumed, false)
    assert.match(d.reason, /requested session unreadable/)
  })

  it('mints fresh when the requested session has no replayable content', () => {
    const d = decideStartupSession(input({
      resumeSessionId: 'empty',
      load: () => ({ hasContent: false, status: 'active', cwd: CWD }),
    }))
    assert.equal(d.resumed, false)
    assert.match(d.reason, /no replayable content/)
  })

  it('rejects a requested session belonging to another cwd', () => {
    const d = decideStartupSession(input({
      currentCwd: '/proj/b',
      resumeSessionId: 'target-99',
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: '/proj/a' }),
    }))
    assert.equal(d.resumed, false)
    assert.match(d.reason, /another cwd/)
  })

  it('forceNew still wins over resumeSessionId', () => {
    const d = decideStartupSession(input({
      forceNew: true,
      resumeSessionId: 'target-99',
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now(), cwd: CWD }),
    }))
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })
})
