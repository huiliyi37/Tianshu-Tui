import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildWorkerKnowledgeBlock, MAX_KNOWLEDGE_CLAIMS } from '../worker-knowledge.js'
import type { ContextClaim } from '../../context/claims.js'

function claim(overrides: Partial<ContextClaim> = {}): ContextClaim {
  return {
    id: 'c1',
    kind: 'user_constraint',
    scope: 'session',
    status: 'active',
    text: 'Use TypeScript strict mode',
    confidence: 0.9,
    fitness: 5,
    source: { actor: 'user', sessionId: 's1', turn: 0, eventId: 'e1' },
    evidence: [],
    consumers: [],
    counterevidence: [],
    createdAt: 1000,
    lastUsedAt: 1000,
    tags: [],
    ...overrides,
  }
}

describe('worker-knowledge', () => {
  it('builds a knowledge block from active claims limited to MAX_KNOWLEDGE_CLAIMS', () => {
    const claims = Array.from({ length: 15 }, (_, i) =>
      claim({ id: `c${i}`, text: `Claim ${i}`, fitness: i + 1 })
    )
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('<worker-knowledge>'))
    assert.ok(block.includes('</worker-knowledge>'))
    // Top MAX_KNOWLEDGE_CLAIMS by fitness
    assert.ok(block.includes('Claim 14'))
    assert.ok(!block.includes('Claim 0'))
    const count = (block.match(/<claim /g) ?? []).length
    assert.equal(count, MAX_KNOWLEDGE_CLAIMS)
  })

  it('filters out worker_finding claims to prevent circular knowledge', () => {
    const claims = [
      claim({ id: 'c1', kind: 'user_constraint', text: 'Constraint', fitness: 10 }),
      claim({ id: 'c2', kind: 'worker_finding', text: 'Worker found X', fitness: 9 }),
    ]
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('Constraint'))
    assert.ok(!block.includes('Worker found X'))
  })

  it('returns empty string for empty claims', () => {
    assert.equal(buildWorkerKnowledgeBlock([]), '')
  })

  it('wraps claims as XML with confidence and fitness attributes', () => {
    const claims = [claim({ id: 'c1', confidence: 0.85, fitness: 5, text: 'Test claim' })]
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(block.includes('confidence="0.85"'), `expected confidence attr in: ${block}`)
    assert.ok(block.includes('fitness="5"'), `expected fitness attr in: ${block}`)
  })

  it('XML-escapes special characters in claim text', () => {
    const claims = [claim({ id: 'c1', text: 'Use <strict> mode & "check"', fitness: 10 })]
    const block = buildWorkerKnowledgeBlock(claims)
    assert.ok(!block.includes('<strict>'), 'must escape <')
    assert.ok(block.includes('&lt;strict&gt;'), 'should have escaped < and >')
    assert.ok(block.includes('&amp;'), 'should escape &')
    assert.ok(block.includes('&quot;'), 'should escape "')
  })
})
