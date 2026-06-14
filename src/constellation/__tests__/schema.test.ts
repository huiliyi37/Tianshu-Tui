import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  createConstellation,
  normalizeConstellation,
  shortHash,
  CONSTELLATION_VERSION,
} from '../schema.js'

test('createConstellation seeds version + empty chains', () => {
  const c = createConstellation({ projectId: 'p1', name: 'Proj', now: 100 })
  assert.equal(c.version, CONSTELLATION_VERSION)
  assert.equal(c.projectId, 'p1')
  assert.equal(c.name, 'Proj')
  assert.equal(c.createdAt, 100)
  assert.equal(c.lastUpdatedAt, 100)
  assert.deepEqual(c.milestones, [])
  assert.deepEqual(c.architectureShifts, [])
})

test('shortHash is stable and 12 hex chars', () => {
  const a = shortHash('hello')
  const b = shortHash('hello')
  assert.equal(a, b)
  assert.match(a, /^[0-9a-f]{12}$/)
  assert.notEqual(shortHash('hello'), shortHash('world'))
})

test('normalizeConstellation rejects unusable top-level shapes', () => {
  assert.equal(normalizeConstellation(null), null)
  assert.equal(normalizeConstellation('nope'), null)
  assert.equal(normalizeConstellation({}), null) // no projectId
})

test('normalizeConstellation drops malformed milestones but keeps valid ones', () => {
  const c = normalizeConstellation({
    projectId: 'p',
    name: 'P',
    createdAt: 1,
    milestones: [
      { id: 'good', timestamp: 2, sessionId: 's', summary: 'x', type: 'feature', verificationStatus: 'verified', filesChanged: ['a.ts'], agentMark: { numericId: 1, symbol: '✦', domain: '' }, cycleClose: 'cc', tags: [] },
      { timestamp: 3 }, // no id → dropped
      'garbage',
    ],
  })
  assert.ok(c)
  assert.equal(c!.milestones.length, 1)
  assert.equal(c!.milestones[0]!.id, 'good')
  assert.equal(c!.milestones[0]!.type, 'feature')
})

test('normalizeConstellation coerces unknown enum values to safe defaults', () => {
  const c = normalizeConstellation({
    projectId: 'p',
    milestones: [
      { id: 'm', type: 'bogus', verificationStatus: 'weird' },
    ],
  })
  assert.equal(c!.milestones[0]!.type, 'milestone')
  assert.equal(c!.milestones[0]!.verificationStatus, 'unverified')
})
