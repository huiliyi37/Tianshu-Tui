import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideStartupSession, RESUME_FRESHNESS_MS } from '../session-recovery.js'

const baseLoad = () => ({ hasContent: true, status: 'active' as const, updatedAt: Date.now() })

describe('session-recovery: decideStartupSession (B3 auto-resume)', () => {
  it('resumes a recent interrupted session with content', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: false, load: baseLoad,
    })
    assert.equal(d.resumed, true)
    assert.equal(d.sessionId, 'sess-1')
  })

  it('mints new when there is no previous session', () => {
    const d = decideStartupSession({
      lastSessionId: null, now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: false, load: baseLoad,
    })
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('mints new when previous session has no replayable content', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: false,
      load: () => ({ hasContent: false, status: 'active' }),
    })
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('does not resume completed/archived sessions', () => {
    for (const status of ['completed', 'archived'] as const) {
      const d = decideStartupSession({
        lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
        forceNew: false, disableAutoResume: false,
        load: () => ({ hasContent: true, status }),
      })
      assert.equal(d.resumed, false, `status=${status}`)
    }
  })

  it('does not resume stale sessions beyond the freshness window', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: false,
      load: () => ({ hasContent: true, status: 'active', updatedAt: Date.now() - RESUME_FRESHNESS_MS - 1 }),
    })
    assert.equal(d.resumed, false)
  })

  it('RIVET_NEW_SESSION forces a fresh session', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: true, disableAutoResume: false, load: baseLoad,
    })
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('RIVET_NO_AUTO_RESUME disables auto-resume', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: true, load: baseLoad,
    })
    assert.equal(d.resumed, false)
    assert.equal(d.sessionId, null)
  })

  it('mints new when the previous session is unreadable', () => {
    const d = decideStartupSession({
      lastSessionId: 'sess-1', now: Date.now(), freshnessMs: RESUME_FRESHNESS_MS,
      forceNew: false, disableAutoResume: false, load: () => null,
    })
    assert.equal(d.resumed, false)
  })
})
