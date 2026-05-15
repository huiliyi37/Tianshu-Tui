import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import type { ContextLedger } from '../../context/types.js'
import { createContextLedger } from '../../context/ledger.js'

function makeLedger(): ContextLedger {
  return createContextLedger('test-session', '/tmp/test.jsonl', [], 10000)
}

describe('SessionContext context ledger state', () => {
  it('stores context ledger immutably', () => {
    const session = new SessionContext()
    const ledger = makeLedger()
    session.setContextLedger(ledger)
    assert.equal(session.getContextLedger()?.sessionId, 'test-session')
    assert.equal(session.getContextLedger()?.tokenBudget.maxTokens, 10000)
  })

  it('records compact events immutably', () => {
    const session = new SessionContext()
    session.recordCompactEvent({
      turn: 2,
      tier: 1,
      reason: 'tool results exceeded budget',
      beforeTokens: 900,
      afterTokens: 700,
      createdAt: 1000,
    })
    session.recordCompactEvent({
      turn: 5,
      tier: 2,
      reason: 'session memory compact',
      beforeTokens: 800,
      afterTokens: 400,
      createdAt: 2000,
    })

    const events = session.getCompactEvents()
    assert.equal(events.length, 2)
    assert.equal(events[0]!.turn, 2)
    assert.equal(events[1]!.tier, 2)
    // Verify immutability — returned array is a copy
    events.push({} as any)
    assert.equal(session.getCompactEvents().length, 2)
  })

  it('returns unique working set from read and modified files', () => {
    const session = new SessionContext()
    session.trackFileRead('/repo/a.ts')
    session.trackFileRead('/repo/b.ts')
    session.trackFileModified('/repo/a.ts')
    session.trackFileModified('/repo/c.ts')

    const ws = session.getWorkingSet()
    assert.deepEqual(ws.sort(), ['/repo/a.ts', '/repo/b.ts', '/repo/c.ts'])
  })
})
