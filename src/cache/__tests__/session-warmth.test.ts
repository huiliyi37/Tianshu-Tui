import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionWarmthTracker } from '../session-warmth.js'

describe('SessionWarmthTracker', () => {
  it('returns cold before any API call', () => {
    const tracker = new SessionWarmthTracker({ now: () => 1000000 })
    assert.equal(tracker.predict(), 'cold')
  })

  it('returns hot immediately after API call', () => {
    const tracker = new SessionWarmthTracker({ now: () => 1000 })
    tracker.recordApiCall()
    assert.equal(tracker.predict(), 'hot')
  })

  it('returns warm after moderate delay', () => {
    let time = 1000
    const tracker = new SessionWarmthTracker({ now: () => time })
    tracker.recordApiCall()
    time = 121_000
    assert.equal(tracker.predict(), 'warm')
  })

  it('returns cold after exceeding TTL', () => {
    let time = 0
    const tracker = new SessionWarmthTracker({ now: () => time, ttlMs: 300_000 })
    tracker.recordApiCall()
    time = 400_000
    assert.equal(tracker.predict(), 'cold')
  })

  it('shouldOpportunisticCompact returns true when cold', () => {
    let time = 0
    const tracker = new SessionWarmthTracker({ now: () => time, ttlMs: 60_000 })
    tracker.recordApiCall()
    time = 120_000
    assert.equal(tracker.shouldOpportunisticCompact(), true)
  })
})
