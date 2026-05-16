import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluatePromotion, claimHasFileEvidence, countClaimsByStatus } from '../promotion.js'
import type { ContextClaim } from '../claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Run tests before claiming done',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'e1', kind: 'user_message', summary: 'Run tests', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: ['anchor'],
    ...overrides,
  }
}

describe('evaluatePromotion', () => {
  it('promotes active claims with three prompt consumers and no counterevidence', () => {
    const result = evaluatePromotion(claim({
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4)

    assert.equal(result, 'durable_candidate')
  })

  it('does not promote claims with counterevidence or expiry', () => {
    assert.equal(evaluatePromotion(claim({
      counterevidence: [{ id: 'ce1', kind: 'tool_result', summary: 'contradicted', createdAt: 2 }],
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)

    assert.equal(evaluatePromotion(claim({
      expiresAt: 4,
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)
  })

  it('does not promote with fewer than 3 consumers', () => {
    assert.equal(evaluatePromotion(claim({
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
      ],
    }), 3), null)
  })

  it('does not promote non-active claims', () => {
    assert.equal(evaluatePromotion(claim({
      status: 'stale',
      consumers: [
        { id: 'turn-1:prompt', kind: 'prompt', usedAt: 1 },
        { id: 'turn-2:prompt', kind: 'prompt', usedAt: 2 },
        { id: 'turn-3:prompt', kind: 'prompt', usedAt: 3 },
      ],
    }), 4), null)
  })
})

describe('claimHasFileEvidence', () => {
  it('matches file evidence by path', () => {
    const observed = claim({
      kind: 'file_observation',
      evidence: [{ id: 'f1', kind: 'file', summary: 'read config', path: '/repo/src/config.ts', createdAt: 1 }],
    })

    assert.equal(claimHasFileEvidence(observed, '/repo/src/config.ts'), true)
    assert.equal(claimHasFileEvidence(observed, '/repo/src/other.ts'), false)
  })

  it('matches verification_fact claims too', () => {
    const vf = claim({
      kind: 'verification_fact',
      evidence: [{ id: 'v1', kind: 'test', summary: 'test passed', path: '/repo/src/a.test.ts', createdAt: 1 }],
    })

    assert.equal(claimHasFileEvidence(vf, '/repo/src/a.test.ts'), true)
  })

  it('returns false for non-file-evidence claim kinds', () => {
    const uc = claim({ kind: 'user_constraint', evidence: [{ id: 'e1', kind: 'user_message', summary: 'x', path: '/a.ts', createdAt: 1 }] })
    assert.equal(claimHasFileEvidence(uc, '/a.ts'), false)
  })
})

describe('countClaimsByStatus', () => {
  it('counts claims by lifecycle status', () => {
    assert.deepEqual(countClaimsByStatus([
      claim({ id: 'a', status: 'active' }),
      claim({ id: 's', status: 'stale' }),
      claim({ id: 'd', status: 'durable' }),
      claim({ id: 'c', status: 'conflicted' }),
    ]), { active: 1, stale: 1, conflicted: 1, durable: 1, durableCandidate: 0, quarantined: 0 })
  })

  it('returns zeros for empty array', () => {
    assert.deepEqual(countClaimsByStatus([]), { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0 })
  })
})
