import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  checkpointClaims,
  loadClaimSnapshot,
  type ContextClaim,
} from '../claims.js'

function makeClaim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'abc123',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'always use strict mode',
    confidence: 0.9,
    fitness: 0.8,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'ev1', kind: 'user_message', summary: 'test', createdAt: 1000 }],
    consumers: [],
    counterevidence: [],
    createdAt: 1000,
    lastUsedAt: 1000,
    tags: ['strict'],
    ...overrides,
  }
}

describe('claim checkpoint — 溶解即新生', () => {
  it('checkpointClaims filters stale claims', () => {
    const claims = [
      makeClaim({ id: 'alive', status: 'active' }),
      makeClaim({ id: 'dead', status: 'stale' }),
    ]
    const snap = checkpointClaims(claims)
    assert.equal(snap.claims.length, 1)
    assert.equal(snap.claims[0]!.id, 'alive')
  })

  it('checkpointClaims filters expired claims', () => {
    const now = 5000
    const claims = [
      makeClaim({ id: 'alive' }),
      makeClaim({ id: 'expired', expiresAt: 3000 }),
    ]
    const snap = checkpointClaims(claims, now)
    assert.equal(snap.claims.length, 1)
    assert.equal(snap.claims[0]!.id, 'alive')
  })

  it('checkpointClaims preserves quarantined in snapshot (not stale)', () => {
    const claims = [makeClaim({ id: 'q', status: 'quarantined' })]
    const snap = checkpointClaims(claims)
    assert.equal(snap.claims.length, 0) // quarantined is also filtered
  })

  it('loadClaimSnapshot restores claims with refreshed lastUsedAt', () => {
    const snap = {
      version: 1 as const,
      createdAt: 1000,
      claims: [makeClaim({ lastUsedAt: 500 })],
    }
    const restored = loadClaimSnapshot(snap, 9999)
    assert.equal(restored.length, 1)
    assert.equal(restored[0]!.lastUsedAt, 9999)
  })

  it('loadClaimSnapshot returns empty for wrong version', () => {
    const snap = { version: 99 as 1, createdAt: 1000, claims: [makeClaim()] }
    const restored = loadClaimSnapshot(snap)
    assert.equal(restored.length, 0)
  })

  it('round-trip: checkpoint → load preserves claim data', () => {
    const original = [
      makeClaim({ id: 'x', text: 'hello', confidence: 0.85, tags: ['a', 'b'] }),
    ]
    const snap = checkpointClaims(original, 1000)
    const restored = loadClaimSnapshot(snap, 2000)
    assert.equal(restored[0]!.id, 'x')
    assert.equal(restored[0]!.text, 'hello')
    assert.equal(restored[0]!.confidence, 0.85)
    assert.deepEqual(restored[0]!.tags, ['a', 'b'])
    assert.equal(restored[0]!.lastUsedAt, 2000) // refreshed
  })
})
