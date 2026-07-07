import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { selectEvictionCandidates, MAX_ACTIVE_CLAIMS } from '../claim-budget.js'
import type { ContextClaim } from '../claims.js'

function claim(id: string, overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id,
    kind: 'file_observation',
    scope: 'session',
    status: 'active',
    text: `claim ${id}`,
    confidence: 0.7,
    fitness: 3,
    source: { actor: 'tool', sessionId: 's1', turn: 1, eventId: 'e1' },
    evidence: [{ id: 'ev1', kind: 'tool_result', summary: 'x', createdAt: 1 }],
    counterevidence: [],
    consumers: [],
    createdAt: 1,
    lastUsedAt: 1,
    tags: [],
    ...overrides,
  }
}

describe('selectEvictionCandidates', () => {
  it('returns empty when under budget', () => {
    const claims = Array.from({ length: 10 }, (_, i) => claim(`c${i}`))
    assert.deepEqual(selectEvictionCandidates(claims), [])
  })

  it('evicts lowest fitness+confidence claims when over budget', () => {
    const claims = Array.from({ length: MAX_ACTIVE_CLAIMS + 5 }, (_, i) =>
      claim(`c${i}`, { fitness: i, confidence: 0.5 + i * 0.01 }),
    )

    const evicted = selectEvictionCandidates(claims)

    assert.equal(evicted.length, 5)
    assert.deepEqual(evicted.map(c => c.id), ['c0', 'c1', 'c2', 'c3', 'c4'])
  })

  it('never evicts project_rule claims', () => {
    const rules = Array.from({ length: 5 }, (_, i) =>
      claim(`rule${i}`, { kind: 'project_rule', fitness: 0, confidence: 0.1 }),
    )
    const regular = Array.from({ length: MAX_ACTIVE_CLAIMS + 3 }, (_, i) =>
      claim(`c${i}`, { fitness: 5 }),
    )

    const evicted = selectEvictionCandidates([...rules, ...regular])

    assert.ok(evicted.every(c => c.kind !== 'project_rule'))
    assert.equal(evicted.length, 3)
  })

  it('never evicts user_constraint claims', () => {
    const constraints = [claim('uc1', { kind: 'user_constraint', fitness: 0 })]
    const regular = Array.from({ length: MAX_ACTIVE_CLAIMS + 1 }, (_, i) =>
      claim(`c${i}`, { fitness: 5 }),
    )

    const evicted = selectEvictionCandidates([...constraints, ...regular])

    assert.ok(evicted.every(c => c.kind !== 'user_constraint'))
    assert.equal(evicted.length, 1)
  })
})
