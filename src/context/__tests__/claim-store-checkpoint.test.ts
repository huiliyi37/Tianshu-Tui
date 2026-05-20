import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { ContextClaimStore } from '../claim-store.js'
import type { ClaimProposal } from '../claims.js'

function proposal(text: string, eventId: string): ClaimProposal {
  return {
    kind: 'decision',
    scope: 'session',
    text,
    confidence: 0.8,
    fitness: 0.5,
    tags: [],
    evidence: [],
    source: { actor: 'assistant', sessionId: 'test-session', turn: 1, eventId },
    createdAt: Date.now(),
  }
}

describe('ContextClaimStore checkpoint — 溶解即新生', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'claim-store-cp-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('writes snapshot and truncates JSONL while preserving current store state', () => {
    const store = new ContextClaimStore(dir, 'session-1')
    store.propose(proposal('use ESM', 'e1'))
    store.propose(proposal('use strict', 'e2'))

    const result = store.checkpoint(1234)

    assert.equal(result.claimCount, 2)
    assert.ok(existsSync(result.snapshotPath))
    assert.equal(readFileSync(result.truncatedPath, 'utf-8'), '')
    assert.deepEqual(store.listClaims().map(c => c.text).sort(), ['use ESM', 'use strict'])
  })

  it('replays incremental JSONL events after snapshot on reload', () => {
    const store = new ContextClaimStore(dir, 'session-2')
    store.propose(proposal('before checkpoint', 'e1'))
    store.checkpoint(1234)
    store.propose(proposal('after checkpoint', 'e2'))

    const reloaded = new ContextClaimStore(dir, 'session-2')
    const texts = reloaded.listClaims().map(c => c.text).sort()

    assert.deepEqual(texts, ['after checkpoint', 'before checkpoint'])
  })

  it('filters stale claims from checkpoint snapshot', () => {
    const store = new ContextClaimStore(dir, 'session-3')
    const alive = store.propose(proposal('alive', 'e1'))
    const stale = store.propose(proposal('stale', 'e2'))
    store.updateClaimStatus(stale.id, 'stale', 'obsolete')

    const result = store.checkpoint(1234)
    const snapshot = JSON.parse(readFileSync(result.snapshotPath, 'utf-8')) as { claims: Array<{ id: string }> }

    assert.deepEqual(snapshot.claims.map(c => c.id), [alive.id])
    assert.deepEqual(store.listClaims().map(c => c.id), [alive.id])
  })
})
