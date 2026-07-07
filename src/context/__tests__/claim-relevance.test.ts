import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectRelevantClaims } from '../claim-relevance.js'
import type { ContextClaim } from '../claims.js'

const now = 1_700_000_000_000

function claim(overrides: Partial<ContextClaim>): ContextClaim {
  return {
    id: overrides.id ?? `c-${Math.random()}`,
    kind: overrides.kind ?? 'file_observation',
    scope: overrides.scope ?? 'session',
    status: overrides.status ?? 'active',
    text: overrides.text ?? 'Read unrelated file',
    confidence: overrides.confidence ?? 0.6,
    fitness: overrides.fitness ?? 1,
    source: overrides.source ?? { actor: 'tool', sessionId: 's', turn: 1, eventId: 'e' },
    evidence: overrides.evidence ?? [{ id: 'e', kind: 'tool_result', summary: overrides.text ?? 'summary', createdAt: now }],
    consumers: overrides.consumers ?? [],
    counterevidence: overrides.counterevidence ?? [],
    createdAt: overrides.createdAt ?? now,
    lastUsedAt: overrides.lastUsedAt ?? now,
    expiresAt: overrides.expiresAt,
    tags: overrides.tags ?? [],
  }
}

describe('claim relevance gate', () => {
  it('keeps user constraints even when unrelated', () => {
    const result = selectRelevantClaims([
      claim({ id: 'constraint', kind: 'user_constraint', text: 'Never expose API keys', confidence: 0.9 }),
      claim({ id: 'file', kind: 'file_observation', text: 'Read old file', lastUsedAt: now - 3_600_001 }),
    ], { query: 'plan workflow', now, maxClaims: 1 })

    assert.deepEqual(result.selected.map(c => c.id), ['constraint'])
  })

  it('filters unmatched low-value file observations', () => {
    const result = selectRelevantClaims([
      claim({ id: 'file', kind: 'file_observation', text: 'Read unrelated old file', lastUsedAt: now - 3_600_001 }),
    ], { query: 'Context7 MCP', now })

    assert.deepEqual(result.selected, [])
    assert.equal(result.omitted[0]?.claim.id, 'file')
  })

  it('keeps file observations when working set evidence matches', () => {
    const result = selectRelevantClaims([
      claim({
        id: 'volatile',
        kind: 'file_observation',
        text: 'Read volatile.ts',
        evidence: [{ id: 'e1', kind: 'file', summary: 'read', path: 'src/prompt/volatile.ts', createdAt: now }],
      }),
    ], { workingSet: ['src/prompt/volatile.ts'], now })

    assert.deepEqual(result.selected.map(c => c.id), ['volatile'])
  })

  it('uses query tags and text matches for ranking', () => {
    const result = selectRelevantClaims([
      claim({ id: 'unrelated', kind: 'decision', text: 'Use pastel theme' }),
      claim({ id: 'context', kind: 'worker_finding', text: 'Context payload has too many active claims', tags: ['context', 'payload'] }),
    ], { query: 'context payload', now, maxClaims: 2 })

    assert.equal(result.selected[0]?.id, 'context')
  })

  it('excludes expired and non-eligible claims', () => {
    const result = selectRelevantClaims([
      claim({ id: 'expired', kind: 'user_constraint', text: 'old', expiresAt: now - 1 }),
      claim({ id: 'stale', kind: 'user_constraint', text: 'stale', status: 'stale' }),
    ], { now })

    assert.deepEqual(result.selected, [])
    assert.deepEqual(result.scored, [])
  })

  it('respects maxClaims while allowing hard-keep claims', () => {
    const result = selectRelevantClaims([
      claim({ id: 'a', kind: 'decision', text: 'context payload decision', tags: ['context'] }),
      claim({ id: 'b', kind: 'decision', text: 'context payload another decision', tags: ['context'] }),
      claim({ id: 'c', kind: 'user_constraint', text: 'Always run tests' }),
    ], { query: 'context', now, maxClaims: 1 })

    assert.ok(result.selected.some(c => c.id === 'c'))
    assert.ok(result.selected.length >= 1)
    assert.ok(result.omitted.some(c => c.claim.id === 'a' || c.claim.id === 'b'))
  })

  it('keeps failed verification facts as hard safety context', () => {
    const result = selectRelevantClaims([
      claim({ id: 'failed-test', kind: 'verification_fact', text: 'Tests failed for payload diagnostics', confidence: 0.88 }),
    ], { query: 'unrelated', now, maxClaims: 1 })

    assert.deepEqual(result.selected.map(c => c.id), ['failed-test'])
  })
})
