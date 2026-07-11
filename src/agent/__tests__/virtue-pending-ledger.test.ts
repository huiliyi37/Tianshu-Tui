import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createVirtuePendingLedger, type VirtuePending } from '../virtue-signals.js'
import type { VirtueSignal, VirtueType } from '../virtue-signals.js'

function mkSignal(type: VirtueType): VirtueSignal {
  return {
    type,
    confidence: 0.7,
    wuchang: type === 'independent-judgment' ? '仁'
      : type === 'proactive-verification' ? '义'
      : type === 'boundary-respect' ? '礼'
      : type === 'strategic-awareness' ? '智'
      : '信',
    evidence: `test evidence for ${type}`,
  }
}

function mkPending(signal: VirtueSignal, detectedTurn: number, windowTurns = 2): VirtuePending {
  return {
    signal,
    detectedTurn,
    utilityExpect: { kind: 'tool_appears', tools: ['read_file', 'edit_file'], withinTurns: windowTurns },
    windowTurns,
  }
}

describe('VirtuePendingLedger', () => {
  it('starts empty', () => {
    const ledger = createVirtuePendingLedger()
    assert.deepEqual(ledger.drainSettled(1), [])
  })

  it('accepts pending entries without settling', () => {
    const ledger = createVirtuePendingLedger()
    ledger.submit(mkPending(mkSignal('independent-judgment'), 1))
    // Turn 1 → window=2 → deadline=3, at turn 2 not yet settled
    assert.deepEqual(ledger.drainSettled(2), [])
  })

  it('settles entries past their deadline', () => {
    const ledger = createVirtuePendingLedger()
    const pending = mkPending(mkSignal('independent-judgment'), 1, 2)
    ledger.submit(pending)
    // deadline = detectedTurn + windowTurns = 3; at turn 3 → settled
    const settled = ledger.drainSettled(3)
    assert.equal(settled.length, 1)
    assert.equal(settled[0]!.signal.type, 'independent-judgment')
  })

  it('drainSettled clears settled entries but keeps pending', () => {
    const ledger = createVirtuePendingLedger()
    ledger.submit(mkPending(mkSignal('independent-judgment'), 1, 2))
    ledger.submit(mkPending(mkSignal('proactive-verification'), 3, 2))
    // First settles at turn 3, second settles at turn 5
    const settled1 = ledger.drainSettled(3)
    assert.equal(settled1.length, 1)
    const settled2 = ledger.drainSettled(4)
    assert.equal(settled2.length, 0) // second not yet
    const settled3 = ledger.drainSettled(5)
    assert.equal(settled3.length, 1)
  })

  it('pendingCount tracks outstanding entries', () => {
    const ledger = createVirtuePendingLedger()
    assert.equal(ledger.pendingCount(), 0)
    ledger.submit(mkPending(mkSignal('boundary-respect'), 1, 3))
    assert.equal(ledger.pendingCount(), 1)
    ledger.drainSettled(4)
    assert.equal(ledger.pendingCount(), 0)
  })

  it('entries settle exactly at deadline, not before', () => {
    const ledger = createVirtuePendingLedger()
    ledger.submit(mkPending(mkSignal('strategic-awareness'), 2, 2))
    // deadline = 4
    assert.equal(ledger.drainSettled(3).length, 0)
    assert.equal(ledger.drainSettled(4).length, 1)
  })

  it('handles multiple signals of same type', () => {
    const ledger = createVirtuePendingLedger()
    ledger.submit(mkPending(mkSignal('independent-judgment'), 1, 2))
    ledger.submit(mkPending(mkSignal('independent-judgment'), 2, 2))
    // First settles at 3, second at 4
    assert.equal(ledger.drainSettled(3).length, 1)
    assert.equal(ledger.drainSettled(4).length, 1)
    assert.equal(ledger.pendingCount(), 0)
  })
})
