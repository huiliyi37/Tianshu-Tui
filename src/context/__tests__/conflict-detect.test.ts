import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectConflicts } from '../conflict-detect.js'
import type { ContextClaim } from '../claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'file_observation',
    scope: 'session',
    status: 'active',
    text: 'config uses port 3000',
    confidence: 0.8,
    fitness: 4,
    source: { actor: 'tool', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'f1', kind: 'file', summary: 'read config', path: '/repo/config.ts', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
    ...overrides,
  }
}

describe('detectConflicts', () => {
  it('detects conflict when two active claims share file evidence path', () => {
    const a = claim({ id: 'c1', text: 'config uses port 3000', createdAt: 1 })
    const b = claim({ id: 'c2', text: 'config uses port 8080', createdAt: 5 })

    const conflicts = detectConflicts([a, b])

    assert.equal(conflicts.length, 1)
    assert.deepEqual(conflicts[0], { olderClaimId: 'c1', newerClaimId: 'c2', sharedPath: '/repo/config.ts' })
  })

  it('does not conflict claims on different files', () => {
    const a = claim({ id: 'c1', evidence: [{ id: 'f1', kind: 'file', summary: 'a', path: '/a.ts', createdAt: 1 }] })
    const b = claim({ id: 'c2', evidence: [{ id: 'f2', kind: 'file', summary: 'b', path: '/b.ts', createdAt: 2 }] })

    assert.deepEqual(detectConflicts([a, b]), [])
  })

  it('does not conflict non-file-observation claims', () => {
    const a = claim({ id: 'c1', kind: 'user_constraint' })
    const b = claim({ id: 'c2', kind: 'user_constraint' })

    assert.deepEqual(detectConflicts([a, b]), [])
  })

  it('does not conflict claims already stale or quarantined', () => {
    const a = claim({ id: 'c1', status: 'stale' })
    const b = claim({ id: 'c2' })

    assert.deepEqual(detectConflicts([a, b]), [])
  })

  it('does not conflict claims with identical normalized text', () => {
    const a = claim({ id: 'c1', text: 'Read config.ts (42 lines)', createdAt: 1 })
    const b = claim({ id: 'c2', text: 'Read config.ts (42 lines)', createdAt: 5 })

    assert.deepEqual(detectConflicts([a, b]), [])
  })

  it('does not conflict claims with same text but different casing/whitespace', () => {
    const a = claim({ id: 'c1', text: 'Read Config.ts  (42 lines)', createdAt: 1 })
    const b = claim({ id: 'c2', text: 'read config.ts (42 lines)', createdAt: 5 })

    assert.deepEqual(detectConflicts([a, b]), [])
  })
})
