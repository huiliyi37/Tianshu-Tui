import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scoreClaimRelevance, selectRelevantClaims } from '../claim-relevance.js'
import type { ContextClaim } from '../claims.js'

const now = 1_700_000_000_000

function makeClaim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: overrides.id ?? 'test-claim',
    kind: overrides.kind ?? 'decision',
    scope: overrides.scope ?? 'session',
    status: overrides.status ?? 'active',
    text: overrides.text ?? 'use ESM',
    confidence: overrides.confidence ?? 0.8,
    fitness: overrides.fitness ?? 0.5,
    source: overrides.source ?? { actor: 'assistant', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: overrides.evidence ?? [{ id: 'ev1', kind: 'tool_result', summary: 'test', createdAt: now }],
    consumers: overrides.consumers ?? [],
    counterevidence: overrides.counterevidence ?? [],
    createdAt: overrides.createdAt ?? now,
    lastUsedAt: overrides.lastUsedAt ?? now,
    expiresAt: overrides.expiresAt,
    tags: overrides.tags ?? [],
  }
}

describe('claim age weighting — epigenetic imprinting', () => {
  it('active claims get no age weight boost', () => {
    const young = makeClaim({ id: 'young', status: 'active', createdAt: now })
    const scored = scoreClaimRelevance(young, { now })
    assert.ok(scored)
    assert.ok(!scored.reasons.some(r => r.startsWith('age-weight')))
  })

  it('durable claims get age weight boost', () => {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    const old = makeClaim({ id: 'old', status: 'durable', createdAt: thirtyDaysAgo })
    const scored = scoreClaimRelevance(old, { now })
    assert.ok(scored)
    assert.ok(scored.reasons.some(r => r.startsWith('age-weight')))
  })

  it('durable_candidate claims also get age weight', () => {
    const fourteenDaysAgo = now - 14 * 24 * 60 * 60 * 1000
    const candidate = makeClaim({ id: 'cand', status: 'durable_candidate', createdAt: fourteenDaysAgo })
    const scored = scoreClaimRelevance(candidate, { now })
    assert.ok(scored)
    assert.ok(scored.reasons.some(r => r.startsWith('age-weight')))
  })

  it('older durable claims score higher than younger ones', () => {
    const sevenDaysAgo = now - 7 * 24 * 60 * 60 * 1000
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    const young = makeClaim({ id: 'young', status: 'durable', createdAt: sevenDaysAgo })
    const old = makeClaim({ id: 'old', status: 'durable', createdAt: thirtyDaysAgo })
    const youngScored = scoreClaimRelevance(young, { now })
    const oldScored = scoreClaimRelevance(old, { now })
    assert.ok(youngScored && oldScored)
    assert.ok(oldScored.score > youngScored.score)
  })

  it('age weight is capped at 2.0', () => {
    const twoYearsAgo = now - 2 * 365 * 24 * 60 * 60 * 1000
    const ancient = makeClaim({ id: 'ancient', status: 'durable', createdAt: twoYearsAgo })
    const scored = scoreClaimRelevance(ancient, { now })
    assert.ok(scored)
    // Cap is 2.0, so age-weight reason should show 2.0
    const ageReason = scored.reasons.find(r => r.startsWith('age-weight'))
    assert.ok(ageReason)
    assert.ok(ageReason!.includes('2.0'))
  })

  it('stale claims do not get age weight', () => {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    const stale = makeClaim({ id: 'stale', status: 'stale', createdAt: thirtyDaysAgo })
    // stale claims are not prompt-eligible, so scoreClaimRelevance returns null
    const scored = scoreClaimRelevance(stale, { now })
    assert.equal(scored, null)
  })

  it('ephemeral claims are not prompt-eligible (returns null)', () => {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    const ephemeral = makeClaim({ id: 'eph', status: 'ephemeral', createdAt: thirtyDaysAgo })
    // ephemeral claims are not prompt-eligible, so scoreClaimRelevance returns null
    const scored = scoreClaimRelevance(ephemeral, { now })
    assert.equal(scored, null)
  })

  it('age weight applies before hard-keep bonus', () => {
    const thirtyDaysAgo = now - 30 * 24 * 60 * 60 * 1000
    // user_constraint is hard-keep, so it gets +1000 on top of age-weighted score
    const old = makeClaim({ id: 'old', kind: 'user_constraint', status: 'durable', createdAt: thirtyDaysAgo })
    const scored = scoreClaimRelevance(old, { now })
    assert.ok(scored)
    assert.ok(scored.reasons.some(r => r.startsWith('age-weight')))
    assert.ok(scored.reasons.some(r => r.startsWith('hard-keep')))
    // Score should be > 1000 (hard-keep) + age-weighted base
    assert.ok(scored.score > 1000)
  })
})
