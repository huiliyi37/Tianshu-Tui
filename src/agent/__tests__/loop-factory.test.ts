import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { AgentLoop } from '../loop.js'
import { buildRuntimeSnapshot } from '../loop-factory.js'

/**
 * Safety net for the loop.ts decomposition (mid-loop). `buildRuntimeSnapshot`
 * is the field-mapping seam every RuntimeHook reads through; pinning it here
 * means a future extraction of snapshot construction out of AgentLoop cannot
 * silently drop or rename a field. It reads a bounded slice of AgentLoop, so a
 * structural stub is enough — no full loop wiring required.
 */
function fakeLoop(over: Partial<Record<string, unknown>> = {}): AgentLoop {
  const base = {
    cwd: '/work',
    session: { getTurnCount: () => 7 },
    recentToolHistory: [
      { tool: 'bash', status: 'ok', target: 'ls', extra: 'dropped' },
      { tool: 'read_file', status: 'error', target: 'a.ts' },
    ],
    sensorium: { mood: 'calm' },
    strategy: 'explore',
    vigorState: { level: 3 },
    gitChangeRate: 0.42,
    currentSeason: 'summer',
    thetaTelemetry: { lastTimedOut: true, consecutiveTimeouts: 2 },
    ...over,
  }
  return base as unknown as AgentLoop
}

test('buildRuntimeSnapshot maps the bounded AgentLoop slice into a snapshot', () => {
  const snap = buildRuntimeSnapshot(fakeLoop())
  assert.equal(snap.cwd, '/work')
  assert.equal(snap.turn, 7)
  assert.equal(snap.strategy, 'explore')
  assert.equal(snap.gitChangeRate, 0.42)
  assert.equal(snap.season, 'summer')
  assert.deepEqual(snap.vigor, { level: 3 })
  assert.deepEqual(snap.sensorium, { mood: 'calm' })
  assert.deepEqual(snap.thetaTelemetry, { lastTimedOut: true, consecutiveTimeouts: 2 })
})

test('buildRuntimeSnapshot projects recentToolHistory to tool/status/target only', () => {
  const snap = buildRuntimeSnapshot(fakeLoop())
  assert.deepEqual(snap.recentToolHistory, [
    { tool: 'bash', status: 'ok', target: 'ls' },
    { tool: 'read_file', status: 'error', target: 'a.ts' },
  ])
  // the source object's extra keys must not leak into the snapshot
  assert.equal('extra' in (snap.recentToolHistory[0] as object), false)
})

test('buildRuntimeSnapshot lets extra override mapped fields (hook augmentation)', () => {
  const snap = buildRuntimeSnapshot(fakeLoop(), { turn: 99, gitChangeRate: 1 })
  assert.equal(snap.turn, 99)
  assert.equal(snap.gitChangeRate, 1)
  // unrelated fields stay intact
  assert.equal(snap.cwd, '/work')
  assert.equal(snap.season, 'summer')
})

test('buildRuntimeSnapshot reads turn count live from the session each call', () => {
  let turns = 1
  const loop = fakeLoop({ session: { getTurnCount: () => turns } })
  assert.equal(buildRuntimeSnapshot(loop).turn, 1)
  turns = 5
  assert.equal(buildRuntimeSnapshot(loop).turn, 5)
})
