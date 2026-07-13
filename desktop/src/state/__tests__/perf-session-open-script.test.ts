import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

test('perf-session-open fixture emits machine-readable metrics for 5000 events and 5 sessions', () => {
  const script = fileURLToPath(new URL('../../../scripts/perf-session-open.ts', import.meta.url))
  const run = spawnSync(process.execPath, ['--import', 'tsx', script], {
    encoding: 'utf8',
  })

  assert.equal(run.status, 0, run.stderr || run.stdout)
  const report = JSON.parse(run.stdout) as {
    fixture: { sessionCount: number; totalEvents: number; eventsPerSession: number }
    metrics: { totalDurationMs: number; sessions: Array<{ eventCount: number; lastSeq: number }> }
  }
  assert.deepEqual(report.fixture, {
    sessionCount: 5,
    totalEvents: 5000,
    eventsPerSession: 1000,
  })
  assert.equal(report.metrics.sessions.length, 5)
  assert.equal(report.metrics.sessions.reduce((sum, session) => sum + session.eventCount, 0), 5000)
  assert.ok(report.metrics.sessions.every((session) => session.lastSeq === 1000))
  assert.ok(Number.isFinite(report.metrics.totalDurationMs))
})
