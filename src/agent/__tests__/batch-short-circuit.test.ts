import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { BatchShortCircuitJudge, cancelRestEnabled } from '../batch-short-circuit.js'
import type { AggregationPolicy, WorkerResult } from '../work-order.js'

function passed(id: string): WorkerResult {
  return {
    workOrderId: id, status: 'passed', summary: 'ok', findings: [],
    artifacts: [], changedFiles: [], risks: [], nextActions: [], evidenceStatus: 'unverified',
  }
}

function blocked(id: string): WorkerResult {
  return { ...passed(id), status: 'blocked', evidenceStatus: 'blocked' }
}

function makeProfiles(ids: string[], profile: string): Map<string, string> {
  return new Map(ids.map(id => [id, profile]))
}

describe('BatchShortCircuitJudge', () => {
  it('first_success: first passed triggers cancel_all', () => {
    const j = new BatchShortCircuitJudge('first_success', makeProfiles(['a','b'], 'code_scout'), new Map(), new Map())
    assert.deepEqual(j.onSettle(passed('a')), { kind: 'cancel_all' })
  })

  it('first_success: subsequent passed returns none (idempotent)', () => {
    const j = new BatchShortCircuitJudge('first_success', makeProfiles(['a','b'], 'code_scout'), new Map(), new Map())
    j.onSettle(passed('a'))
    assert.deepEqual(j.onSettle(passed('b')), { kind: 'none' })
  })

  it('first_success: failed does not trigger', () => {
    const j = new BatchShortCircuitJudge('first_success', makeProfiles(['a'], 'code_scout'), new Map(), new Map())
    assert.deepEqual(j.onSettle(blocked('a')), { kind: 'none' })
  })

  it('quorum k=2: first passed → none, second → cancel_group', () => {
    const gm = new Map([['g', ['a','b','c']]])
    const go = new Map([['a','g'],['b','g'],['c','g']])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 2 }, makeProfiles(['a','b','c'], 'code_scout'), gm, go)
    assert.deepEqual(j.onSettle(passed('a')), { kind: 'none' })
    assert.deepEqual(j.onSettle(passed('b')), { kind: 'cancel_group', groupId: 'g' })
  })

  it('quorum k=2: third settle after fired returns none', () => {
    const gm = new Map([['g', ['a','b','c']]])
    const go = new Map([['a','g'],['b','g'],['c','g']])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 2 }, makeProfiles(['a','b','c'], 'code_scout'), gm, go)
    j.onSettle(passed('a'))
    j.onSettle(passed('b'))
    assert.deepEqual(j.onSettle(passed('c')), { kind: 'none' })
  })

  it('quorum k=1 via quorumGroups override', () => {
    const gm = new Map([['g', ['a','b']]])
    const go = new Map([['a','g'],['b','g']])
    const qg = new Map([['g', 1]])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 3 }, makeProfiles(['a','b'], 'code_scout'), gm, go, qg)
    assert.deepEqual(j.onSettle(passed('a')), { kind: 'cancel_group', groupId: 'g' })
  })

  it('quorum: independent worker (no groupId) never triggers', () => {
    const go = new Map([['a', undefined]])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 1 }, makeProfiles(['a'], 'code_scout'), new Map(), go)
    assert.deepEqual(j.onSettle(passed('a')), { kind: 'none' })
  })

  it('DP duty guard: verifier in remaining members holds short-circuit', () => {
    const gm = new Map([['g', ['a','b','c']]])
    const go = new Map([['a','g'],['b','g'],['c','g']])
    const pm = new Map([['a','adversarial_verifier'],['b','code_scout'],['c','adversarial_verifier']])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 2 }, pm, gm, go)
    j.onSettle(passed('a'))
    // a passed (k=1) but verified count still < k (verified=1 from verifier),
    // and remaining c is verifier → hold (evidence still possible)
    assert.deepEqual(j.onSettle(passed('b')), { kind: 'none' })
  })

  it('DP duty guard: no verifier remaining → allows short-circuit', () => {
    const gm = new Map([['g', ['a','b','c']]])
    const go = new Map([['a','g'],['b','g'],['c','g']])
    const pm = new Map([['a','code_scout'],['b','code_scout'],['c','code_scout']])
    const j = new BatchShortCircuitJudge({ kind: 'quorum', k: 2 }, pm, gm, go)
    j.onSettle(passed('a'))
    assert.deepEqual(j.onSettle(passed('b')), { kind: 'cancel_group', groupId: 'g' })
  })

  it('all_required / primary_decides / majority / weighted_confidence never short-circuit', () => {
    for (const p of ['all_required', 'primary_decides', 'majority', 'weighted_confidence'] as AggregationPolicy[]) {
      const j = new BatchShortCircuitJudge(p, makeProfiles(['a'], 'code_scout'), new Map(), new Map())
      assert.deepEqual(j.onSettle(passed('a')), { kind: 'none' })
    }
  })

  it('cancellable: hands profile returns false', () => {
    const j = new BatchShortCircuitJudge('first_success', new Map(), new Map(), new Map())
    assert.equal(j.cancellable({ id: 'a', profile: 'patcher' } as any), false)
    assert.equal(j.cancellable({ id: 'b', profile: 'code_scout' } as any), true)
  })

  it('cancelRestEnabled respects RIVET_CANCEL_REST', () => {
    const prev = process.env.RIVET_CANCEL_REST
    process.env.RIVET_CANCEL_REST = '0'
    assert.equal(cancelRestEnabled(), false)
    process.env.RIVET_CANCEL_REST = 'false'
    assert.equal(cancelRestEnabled(), false)
    process.env.RIVET_CANCEL_REST = 'off'
    assert.equal(cancelRestEnabled(), false)
    process.env.RIVET_CANCEL_REST = 'no'
    assert.equal(cancelRestEnabled(), false)
    process.env.RIVET_CANCEL_REST = '1'
    assert.equal(cancelRestEnabled(), true)
    process.env.RIVET_CANCEL_REST = prev
  })
})
