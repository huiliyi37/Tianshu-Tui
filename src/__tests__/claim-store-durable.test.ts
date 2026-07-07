import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ContextClaimStore } from '../context/claim-store.js'

describe('loadDurableClaims with claim_used replay', () => {
  it('restores consumers from claim_used events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-'))
    const filePath = join(dir, 'prev-session.claims.jsonl')
    const claim = {
      id: 'claim-1',
      kind: 'user_constraint',
      scope: 'project',
      status: 'durable',
      text: 'Use TypeScript strict mode',
      confidence: 0.9,
      fitness: 7,
      source: { actor: 'user', sessionId: 'prev-session', turn: 1, eventId: 'e-1' },
      evidence: [{ id: 'e-1', kind: 'user_message' as const, summary: 'Use strict mode', createdAt: 1000 }],
      consumers: [] as unknown[],
      counterevidence: [],
      createdAt: 1000,
      lastUsedAt: 1000,
      tags: [],
    }
    const events = [
      JSON.stringify({ type: 'claim_proposed', eventId: 'e-1', createdAt: 1000, claim }),
      JSON.stringify({ type: 'claim_status_changed', eventId: 'e-2', createdAt: 2000, claimId: 'claim-1', status: 'durable', reason: 'promotion' }),
      JSON.stringify({ type: 'claim_used', eventId: 'e-3', createdAt: 3000, claimId: 'claim-1', consumerId: 'turn-5:prompt', consumerKind: 'prompt' }),
      JSON.stringify({ type: 'claim_used', eventId: 'e-4', createdAt: 4000, claimId: 'claim-1', consumerId: 'turn-8:prompt', consumerKind: 'prompt' }),
    ]
    writeFileSync(filePath, events.join('\n') + '\n')

    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 'prev-session')
      assert.equal(durables.length, 1)
      assert.equal(durables[0]!.consumers.length, 2)
      assert.equal(durables[0]!.consumers[0]!.id, 'turn-5:prompt')
      assert.equal(durables[0]!.consumers[1]!.id, 'turn-8:prompt')
      assert.equal(durables[0]!.lastUsedAt, 4000)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array for non-existent session', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-empty-'))
    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 'no-such-session')
      assert.equal(durables.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('ignores claim_used for unknown claimId', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-unknown-'))
    const filePath = join(dir, 's.claims.jsonl')
    writeFileSync(filePath, JSON.stringify({ type: 'claim_used', eventId: 'e-1', createdAt: 1000, claimId: 'unknown', consumerId: 'c1', consumerKind: 'prompt' }) + '\n')
    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 's')
      assert.equal(durables.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('skips non-durable claims even with claim_used events', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-active-'))
    const filePath = join(dir, 's2.claims.jsonl')
    const claim = {
      id: 'c2', kind: 'file_observation', scope: 'session', status: 'active',
      text: 'Read config.ts', confidence: 0.6, fitness: 2,
      source: { actor: 'tool', sessionId: 's2', turn: 1, eventId: 'e-1' },
      evidence: [{ id: 'e-1', kind: 'tool_result' as const, summary: 'read', createdAt: 1000 }],
      consumers: [] as unknown[], counterevidence: [], createdAt: 1000, lastUsedAt: 1000, tags: [],
    }
    const events = [
      JSON.stringify({ type: 'claim_proposed', eventId: 'e-1', createdAt: 1000, claim }),
      JSON.stringify({ type: 'claim_used', eventId: 'e-2', createdAt: 2000, claimId: 'c2', consumerId: 'c1', consumerKind: 'tool' }),
    ]
    writeFileSync(filePath, events.join('\n') + '\n')
    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 's2')
      assert.equal(durables.length, 0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('reuses full projection logic for boosted fitness and counterevidence', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-projection-'))
    const filePath = join(dir, 's3.claims.jsonl')
    const claim = {
      id: 'c3', kind: 'decision', scope: 'project', status: 'active',
      text: 'Persist projection semantics', confidence: 0.8, fitness: 1,
      source: { actor: 'assistant', sessionId: 's3', turn: 1, eventId: 'e-1' },
      evidence: [{ id: 'e-1', kind: 'assistant_message' as const, summary: 'decision', createdAt: 1000 }],
      consumers: [] as unknown[], counterevidence: [], createdAt: 1000, lastUsedAt: 1000, tags: [],
    }
    const events = [
      JSON.stringify({ type: 'claim_proposed', eventId: 'e-1', createdAt: 1000, claim }),
      JSON.stringify({ type: 'claim_boosted', eventId: 'e-2', createdAt: 2000, claimId: 'c3', fitness: 9 }),
      JSON.stringify({ type: 'claim_status_changed', eventId: 'e-3', createdAt: 3000, claimId: 'c3', status: 'durable', reason: 'promotion threshold met' }),
    ]
    writeFileSync(filePath, events.join('\n') + '\n')
    try {
      const durables = ContextClaimStore.loadDurableClaims(dir, 's3')
      assert.equal(durables.length, 1)
      assert.equal(durables[0]!.fitness, 9)
      assert.equal(durables[0]!.counterevidence.length, 1)
      assert.equal(durables[0]!.counterevidence[0]!.summary, 'promotion threshold met')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('loads durable claims from snapshot plus incremental JSONL', () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-durable-snapshot-'))
    try {
      const store = new ContextClaimStore(dir, 's4')
      const claim = store.propose({
        kind: 'decision',
        scope: 'project',
        text: 'Snapshot durable claim',
        confidence: 0.8,
        fitness: 3,
        source: { actor: 'assistant', sessionId: 's4', turn: 1, eventId: 'e-1' },
        evidence: [{ id: 'e-1', kind: 'assistant_message' as const, summary: 'decision', createdAt: 1000 }],
        createdAt: 1000,
        tags: [],
      })
      store.updateClaimStatus(claim.id, 'durable', 'promotion')
      store.checkpoint(2000)

      const durables = ContextClaimStore.loadDurableClaims(dir, 's4')
      assert.equal(durables.length, 1)
      assert.equal(durables[0]!.text, 'Snapshot durable claim')
      assert.equal(durables[0]!.status, 'durable')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
