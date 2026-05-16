import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'
import { SessionPersist } from '../../agent/session-persist.js'

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'rivet-claims-'))
}

function proposal(text = 'Do not repeat failed Read calls'): ClaimProposal {
  return {
    kind: 'user_constraint',
    scope: 'session',
    text,
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'turn-1:user-input' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: text, createdAt: 10 }],
    createdAt: 10,
    tags: ['anchor', 'user_constraint'],
  }
}

test('proposes a claim by appending a JSONL event and projecting current claims', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')

    const claim = store.propose(proposal())
    const claims = store.listClaims()

    assert.equal(claim.status, 'active')
    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.text, 'Do not repeat failed Read calls')

    const raw = readFileSync(store.path, 'utf-8')
    assert.match(raw, /"type":"claim_proposed"/)
    assert.match(raw, /Do not repeat failed Read calls/)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('replays claim status transitions from JSONL', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.updateClaimStatus(claim.id, 'stale', 'evidence expired')

    const reloaded = new ContextClaimStore(dir, 'session-123')
    const claims = reloaded.listClaims()

    assert.equal(claims.length, 1)
    assert.equal(claims[0]?.status, 'stale')
    assert.equal(claims[0]?.counterevidence[0]?.summary, 'evidence expired')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})


test('proposing the same semantic claim is idempotent and preserves status transitions', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const first = store.propose(proposal('Always run tests before done'))
    store.updateClaimStatus(first.id, 'quarantined', 'superseded by counterevidence')
    const repeated = store.propose({
      ...proposal('  always   run tests BEFORE done  '),
      source: { actor: 'user', sessionId: 'session-123', turn: 2, eventId: 'turn-2:user-input' },
      evidence: [{ id: 'e2', kind: 'user_message', summary: 'Always run tests before done', createdAt: 20 }],
      createdAt: 20,
    })

    assert.equal(repeated.id, first.id)
    assert.equal(store.listClaims().length, 1)
    assert.equal(store.listClaims()[0]?.status, 'quarantined')
    assert.equal(store.exportSession().match(/claim_proposed/g)?.length, 1)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('filters active claims and excludes quarantined claims', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const active = store.propose(proposal('Keep this active'))
    const quarantined = store.propose(proposal('Do not project this'))
    store.updateClaimStatus(quarantined.id, 'quarantined', 'counter evidence')

    const activeClaims = store.listActiveClaims()

    assert.deepEqual(activeClaims.map(c => c.id), [active.id])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('ignores invalid JSONL lines while preserving valid events', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())
    writeFileSync(store.path, `${readFileSync(store.path, 'utf-8')}not json\n`, 'utf-8')

    const reloaded = new ContextClaimStore(dir, 'session-123')

    assert.equal(reloaded.listClaims()[0]?.id, claim.id)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('records prompt consumers without changing prompt eligibility', () => {
  const dir = tempDir()
  try {
    const store = new ContextClaimStore(dir, 'session-123')
    const claim = store.propose(proposal())

    store.recordClaimUsed(claim.id, {
      consumerId: 'turn-2:prompt',
      consumerKind: 'prompt',
      usedAt: 20,
    })

    const [used] = store.listActiveClaims()
    assert.equal(used?.lastUsedAt, 20)
    assert.deepEqual(used?.consumers, [{ id: 'turn-2:prompt', kind: 'prompt', usedAt: 20 }])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('SessionPersist creates a claim store for the current session id', () => {
  const persist = new SessionPersist('session-claims-test')
  const store = persist.createClaimStore()

  assert.match(store.path, /session-claims-test\.claims\.jsonl$/)
})
