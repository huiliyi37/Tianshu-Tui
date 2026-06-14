import { test } from 'node:test'
import assert from 'node:assert/strict'
import { extractMilestone, mapVerification } from '../milestone.js'
import type { ChronicleEntry } from '../../agent/chronicle.js'
import type { AgentMark } from '../schema.js'

const mark: AgentMark = { numericId: 42, symbol: '✦', domain: 'yaoguang' }

function entries(files: string[], summary = 'did a thing'): ChronicleEntry[] {
  return [{ type: 'milestone', turn: 1, timestamp: 10, summary, files }]
}

test('mapVerification folds external_blocked into blocked', () => {
  assert.equal(mapVerification('verified'), 'verified')
  assert.equal(mapVerification('failed'), 'failed')
  assert.equal(mapVerification('blocked'), 'blocked')
  assert.equal(mapVerification('external_blocked'), 'blocked')
  assert.equal(mapVerification('unverified'), 'unverified')
  assert.equal(mapVerification(undefined), 'unverified')
})

test('extractMilestone returns null below the noise gate', () => {
  const m = extractMilestone({
    sessionId: 's', agentMark: mark, domain: 'yaoguang',
    chronicleEntries: entries([]), cycleClose: 'cc', minFiles: 1,
  })
  assert.equal(m, null)
})

test('extractMilestone uses writeFileCount when chronicle has no files', () => {
  const m = extractMilestone({
    sessionId: 's', agentMark: mark, domain: 'yaoguang',
    chronicleEntries: [{ type: 'phase-transition', turn: 1, timestamp: 1, summary: 'work' }],
    taskSummary: { writeFileCount: 3, verificationStatus: 'verified' },
    cycleClose: 'cc', minFiles: 1,
  })
  assert.ok(m)
  assert.equal(m!.verificationStatus, 'verified')
  assert.equal(m!.summary, 'work')
})

test('extractMilestone collects files + maps verification + stable id', () => {
  const input = {
    sessionId: 'sess', agentMark: mark, domain: 'yaoguang',
    chronicleEntries: entries(['a.ts', 'b.ts', 'a.ts']),
    taskSummary: { verificationStatus: 'external_blocked' as const, writeFileCount: 2 },
    cycleClose: 'CYCLE', now: 999,
  }
  const m1 = extractMilestone(input)!
  const m2 = extractMilestone(input)!
  assert.deepEqual(m1.filesChanged.sort(), ['a.ts', 'b.ts'])
  assert.equal(m1.verificationStatus, 'blocked')
  assert.equal(m1.summary, 'did a thing')
  assert.equal(m1.timestamp, 999)
  // idempotent id per (sessionId, cycleClose)
  assert.equal(m1.id, m2.id)
})

test('extractMilestone force bypasses the gate', () => {
  const m = extractMilestone({
    sessionId: 's', agentMark: mark, domain: '',
    chronicleEntries: entries([], 'manual note'), cycleClose: 'cc', force: true,
  })
  assert.ok(m)
  assert.equal(m!.summary, 'manual note')
  assert.deepEqual(m!.filesChanged, [])
})
