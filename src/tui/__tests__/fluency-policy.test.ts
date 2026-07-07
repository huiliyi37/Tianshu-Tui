import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeFluencyPolicy,
  computeStageHealth,
  RoutineCounter,
} from '../fluency-policy.js'
import type { ActivityPhase } from '../activity-status.js'

// ---------------------------------------------------------------------------
// computeFluencyPolicy
// ---------------------------------------------------------------------------

describe('computeFluencyPolicy', () => {
  const baseline = {
    phase: 'thinking' as ActivityPhase,
    silentMs: 0,
    outputRate: 0,
    resultLength: 0,
    contextPressure: 0,
    isError: false,
    isApproval: false,
    consecutiveRoutine: 0,
  }

  it('returns inspect when isError is true (regardless of other signals)', () => {
    const policy = computeFluencyPolicy({ ...baseline, isError: true, contextPressure: 0.9, silentMs: 30_000, consecutiveRoutine: 10 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
  })

  it('returns inspect when isApproval is true (regardless of other signals)', () => {
    const policy = computeFluencyPolicy({ ...baseline, isApproval: true, contextPressure: 0.9, silentMs: 30_000, consecutiveRoutine: 10 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
  })

  it('returns stress when contextPressure >= 0.8', () => {
    const policy = computeFluencyPolicy({ ...baseline, contextPressure: 0.8 })
    assert.equal(policy.visibility, 'stress')
    assert.equal(policy.foldRoutine, true)
    assert.ok(policy.coalesceMs >= 1000)
  })

  it('computes coalesceMs from contextPressure', () => {
    const p1 = computeFluencyPolicy({ ...baseline, contextPressure: 0.8 })
    const p2 = computeFluencyPolicy({ ...baseline, contextPressure: 0.9 })
    const p3 = computeFluencyPolicy({ ...baseline, contextPressure: 1.0 })
    assert.equal(p1.coalesceMs, 1000 + Math.round(0.8 * 2000))
    assert.equal(p2.coalesceMs, 1000 + Math.round(0.9 * 2000))
    assert.equal(p3.coalesceMs, 1000 + Math.round(1.0 * 2000))
  })

  it('returns stress at exact boundary contextPressure = 0.8', () => {
    const policy = computeFluencyPolicy({ ...baseline, contextPressure: 0.8 })
    assert.equal(policy.visibility, 'stress')
  })

  it('does not return stress when contextPressure is just below 0.8', () => {
    const policy = computeFluencyPolicy({ ...baseline, contextPressure: 0.799 })
    assert.notEqual(policy.visibility, 'stress')
  })

  it('returns inspect with phase-aware stale message when silentMs >= 30_000 (thinking)', () => {
    const policy = computeFluencyPolicy({ ...baseline, silentMs: 35_000 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
    assert.equal(policy.staleMessage, 'Thinking deeply... 35s')
    assert.equal(policy.staleLevel, 'info')
  })

  it('returns inspect with warn stale message when silentMs >= 90_000 (thinking)', () => {
    const policy = computeFluencyPolicy({ ...baseline, silentMs: 95_000 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.staleMessage, 'Collecting context... 2m')
    assert.equal(policy.staleLevel, 'warn')
  })

  it('returns inspect with actionable stale message when silentMs >= 180_000 (thinking)', () => {
    const policy = computeFluencyPolicy({ ...baseline, silentMs: 190_000 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.staleMessage, 'Long think — Ctrl+C to stop (3m)')
    assert.equal(policy.staleLevel, 'action')
  })

  it('returns inspect with coalescing for large results', () => {
    const policy = computeFluencyPolicy({ ...baseline, resultLength: 60_000 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 1000)
  })

  it('returns inspect with coalescing for high output rate', () => {
    const policy = computeFluencyPolicy({ ...baseline, outputRate: 60_000 })
    assert.equal(policy.visibility, 'inspect')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 1000)
  })

  it('returns quiet when consecutiveRoutine >= 4', () => {
    const policy = computeFluencyPolicy({ ...baseline, consecutiveRoutine: 4 })
    assert.equal(policy.visibility, 'quiet')
    assert.equal(policy.foldRoutine, true)
    assert.equal(policy.coalesceMs, 500)
  })

  it('returns quiet for consecutiveRoutine > 4', () => {
    const policy = computeFluencyPolicy({ ...baseline, consecutiveRoutine: 99 })
    assert.equal(policy.visibility, 'quiet')
  })

  it('returns normal for baseline signals', () => {
    const policy = computeFluencyPolicy(baseline)
    assert.equal(policy.visibility, 'normal')
    assert.equal(policy.foldRoutine, false)
    assert.equal(policy.coalesceMs, 0)
    assert.equal(policy.staleMessage, undefined)
  })

  it('returns normal when consecutiveRoutine is 3', () => {
    const policy = computeFluencyPolicy({ ...baseline, consecutiveRoutine: 3 })
    assert.equal(policy.visibility, 'normal')
  })

  it('returns normal when silentMs is 9_999', () => {
    const policy = computeFluencyPolicy({ ...baseline, silentMs: 9_999 })
    assert.equal(policy.visibility, 'normal')
  })

  it('respects priority: error over approval', () => {
    const policy = computeFluencyPolicy({ ...baseline, isError: true, isApproval: true })
    assert.equal(policy.visibility, 'inspect')
  })

  it('respects priority: error over pressure', () => {
    const policy = computeFluencyPolicy({ ...baseline, isError: true, contextPressure: 0.9 })
    assert.equal(policy.visibility, 'inspect')
  })

  it('respects priority: error over silent', () => {
    const policy = computeFluencyPolicy({ ...baseline, isError: true, silentMs: 30_000 })
    assert.equal(policy.visibility, 'inspect')
  })

  it('respects priority: approval over pressure', () => {
    const policy = computeFluencyPolicy({ ...baseline, isApproval: true, contextPressure: 0.9 })
    assert.equal(policy.visibility, 'inspect')
  })

  it('respects priority: pressure over silent', () => {
    const policy = computeFluencyPolicy({ ...baseline, contextPressure: 0.8, silentMs: 30_000 })
    assert.equal(policy.visibility, 'stress')
  })

  it('respects priority: pressure over routine', () => {
    const policy = computeFluencyPolicy({ ...baseline, contextPressure: 0.8, consecutiveRoutine: 10 })
    assert.equal(policy.visibility, 'stress')
  })

  it('respects priority: silent over routine', () => {
    const policy = computeFluencyPolicy({ ...baseline, silentMs: 35_000, consecutiveRoutine: 10 })
    assert.equal(policy.visibility, 'inspect')
  })

  // All phases should behave identically — spot-check a few
  const phases: ActivityPhase[] = ['idle', 'thinking', 'streaming', 'analyzing', 'tool', 'mcp', 'compacting', 'preflight']
  for (const phase of phases) {
    it(`handles phase '${phase}' with normal signals`, () => {
      const policy = computeFluencyPolicy({ ...baseline, phase })
      assert.equal(policy.visibility, 'normal')
    })
  }
})

// ---------------------------------------------------------------------------
// computeStageHealth
// ---------------------------------------------------------------------------

describe('computeStageHealth', () => {
  const now = 100_000

  it('returns healthy when silentMs is well below threshold', () => {
    const health = computeStageHealth(
      { phase: 'thinking', startedAt: 90_000, lastEventAt: 99_500 },
      now,
    )
    assert.equal(health.silentMs, 500)
    assert.equal(health.durationMs, 10_000)
    assert.equal(health.isStale, false)
    assert.equal(health.healthLabel, 'healthy')
  })

  it('returns slow when silentMs >= 60% of threshold', () => {
    // thinking threshold = 90_000, 60% = 54_000
    const health = computeStageHealth(
      { phase: 'thinking', startedAt: 0, lastEventAt: now - 54_000 },
      now,
    )
    assert.equal(health.silentMs, 54_000)
    assert.equal(health.isStale, false)
    assert.equal(health.healthLabel, 'slow')
  })

  it('returns stale for thinking when silentMs >= 90s', () => {
    const health = computeStageHealth(
      { phase: 'thinking', startedAt: 0, lastEventAt: now - 90_000 },
      now,
    )
    assert.equal(health.silentMs, 90_000)
    assert.equal(health.isStale, true)
    assert.ok(health.healthLabel.startsWith('stale'))
  })

  it('returns stale for streaming when silentMs >= 20s', () => {
    const health = computeStageHealth(
      { phase: 'streaming', startedAt: 0, lastEventAt: now - 20_000 },
      now,
    )
    assert.equal(health.isStale, true)
    assert.equal(health.healthLabel, 'stale (20s silent)')
  })

  it('returns slow for streaming when silentMs >= 12s', () => {
    // streaming threshold = 20_000, 60% = 12_000
    const health = computeStageHealth(
      { phase: 'streaming', startedAt: 0, lastEventAt: now - 12_000 },
      now,
    )
    assert.equal(health.isStale, false)
    assert.equal(health.healthLabel, 'slow')
  })

  it('returns stale for tool phase when silentMs >= 60s', () => {
    const health = computeStageHealth(
      { phase: 'tool', startedAt: 0, lastEventAt: now - 60_000 },
      now,
    )
    assert.equal(health.isStale, true)
    assert.equal(health.healthLabel, 'stale (60s silent)')
  })

  it('returns stale for mcp phase when silentMs >= 30s', () => {
    const health = computeStageHealth(
      { phase: 'mcp', startedAt: 0, lastEventAt: now - 30_000 },
      now,
    )
    assert.equal(health.isStale, true)
    assert.equal(health.healthLabel, 'stale (30s silent)')
  })

  it('returns stale for compacting when silentMs >= 120s', () => {
    const health = computeStageHealth(
      { phase: 'compacting', startedAt: 0, lastEventAt: now - 120_000 },
      now,
    )
    assert.equal(health.isStale, true)
    assert.equal(health.healthLabel, 'stale (120s silent)')
  })

  it('returns stale for analyzing when silentMs >= 30s', () => {
    const health = computeStageHealth(
      { phase: 'analyzing', startedAt: 0, lastEventAt: now - 30_000 },
      now,
    )
    assert.equal(health.isStale, true)
  })

  it('uses default 30s threshold for idle phase', () => {
    const health = computeStageHealth(
      { phase: 'idle', startedAt: 0, lastEventAt: now - 30_000 },
      now,
    )
    assert.equal(health.isStale, true)
  })

  it('uses default 30s threshold for preflight phase', () => {
    const health = computeStageHealth(
      { phase: 'preflight', startedAt: 0, lastEventAt: now - 30_000 },
      now,
    )
    assert.equal(health.isStale, true)
  })

  it('reports durationMs as difference between now and startedAt', () => {
    const health = computeStageHealth(
      { phase: 'thinking', startedAt: 50_000, lastEventAt: 90_000 },
      now,
    )
    assert.equal(health.durationMs, 50_000)
  })

  it('reports zero silentMs when lastEventAt equals now', () => {
    const health = computeStageHealth(
      { phase: 'streaming', startedAt: 90_000, lastEventAt: now },
      now,
    )
    assert.equal(health.silentMs, 0)
    assert.equal(health.isStale, false)
    assert.equal(health.healthLabel, 'healthy')
  })

  it('handles negative silentMs gracefully (clock skew)', () => {
    const health = computeStageHealth(
      { phase: 'thinking', startedAt: 50_000, lastEventAt: now + 100 },
      now,
    )
    assert.equal(health.silentMs, -100)
    assert.equal(health.isStale, false)
    assert.equal(health.healthLabel, 'healthy')
  })
})

// ---------------------------------------------------------------------------
// RoutineCounter
// ---------------------------------------------------------------------------

describe('RoutineCounter', () => {
  it('starts at zero', () => {
    const c = new RoutineCounter()
    assert.equal(c.count, 0)
    assert.equal(c.shouldFold, false)
  })

  it('increments count on record(true)', () => {
    const c = new RoutineCounter()
    c.record(true)
    assert.equal(c.count, 1)
    c.record(true)
    assert.equal(c.count, 2)
  })

  it('resets count to 0 on record(false)', () => {
    const c = new RoutineCounter()
    c.record(true)
    c.record(true)
    c.record(true)
    assert.equal(c.count, 3)
    c.record(false)
    assert.equal(c.count, 0)
  })

  it('shouldFold is false when count < 4', () => {
    const c = new RoutineCounter()
    for (let i = 0; i < 3; i++) c.record(true)
    assert.equal(c.shouldFold, false)
  })

  it('shouldFold is true when count >= 4', () => {
    const c = new RoutineCounter()
    for (let i = 0; i < 4; i++) c.record(true)
    assert.equal(c.shouldFold, true)
  })

  it('shouldFold is true for counts above 4', () => {
    const c = new RoutineCounter()
    for (let i = 0; i < 10; i++) c.record(true)
    assert.equal(c.shouldFold, true)
  })

  it('reset() sets count to 0', () => {
    const c = new RoutineCounter()
    c.record(true)
    c.record(true)
    c.record(true)
    c.record(true)
    assert.equal(c.count, 4)
    c.reset()
    assert.equal(c.count, 0)
    assert.equal(c.shouldFold, false)
  })

  it('interleaving non-routine resets the streak', () => {
    const c = new RoutineCounter()
    c.record(true)
    c.record(true)
    c.record(false) // break streak
    assert.equal(c.count, 0)
    c.record(true) // start new streak
    assert.equal(c.count, 1)
  })

  it('persists count across many calls', () => {
    const c = new RoutineCounter()
    for (let i = 0; i < 100; i++) c.record(true)
    assert.equal(c.count, 100)
    assert.equal(c.shouldFold, true)
  })

  it('shouldFold tracks count dynamically after reset', () => {
    const c = new RoutineCounter()
    c.record(true)
    c.record(true)
    c.record(true)
    c.record(true)
    assert.equal(c.shouldFold, true)
    c.reset()
    assert.equal(c.shouldFold, false)
  })

  it('multiple instances are independent', () => {
    const a = new RoutineCounter()
    const b = new RoutineCounter()
    a.record(true)
    a.record(true)
    a.record(true)
    a.record(true)
    b.record(true)
    assert.equal(a.shouldFold, true)
    assert.equal(b.shouldFold, false)
  })
})
