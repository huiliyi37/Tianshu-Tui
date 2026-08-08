import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRuntimeSelfModel,
  prioritizeRuntimeSignals,
  scoreRuntimeSignal,
} from '../runtime-self-model.js'

describe('RUNTIME_SELF_MODEL', () => {
  it('scores surprise/relevance while keeping risk visible', () => {
    const signal = scoreRuntimeSignal({
      kind: 'worker_stalled',
      surprise: 1,
      relevance: 1,
      cognitiveCost: 0.2,
      risk: 1,
      reason: 'worker stopped producing activity',
    })
    assert.equal(signal.attention, 'urgent')
    assert.equal(signal.score, 1)
    assert.equal(signal.risk, 1)
  })

  it('uses stable ordering when two signals have the same score', () => {
    const ranked = prioritizeRuntimeSignals([
      { kind: 'context_pressure', surprise: 0.5, relevance: 0.5, cognitiveCost: 0.5, risk: 0.5, reason: 'first' },
      { kind: 'context_pressure', surprise: 0.5, relevance: 0.5, cognitiveCost: 0.5, risk: 0.5, reason: 'second' },
    ])
    assert.deepEqual(ranked.map(signal => signal.reason), ['first', 'second'])
  })

  it('marks stalled workers as degraded and prioritizes them above passive pressure', () => {
    const model = buildRuntimeSelfModel({
      now: 123,
      phase: 'galaxy',
      turn: 4,
      contextRatio: 0.7,
      activeClaims: 3,
      verificationDebt: 0.2,
      coordinator: {
        activeWorkers: 3,
        maxWorkers: 4,
        pendingWorkers: 1,
        stalledWorkers: 1,
        inFlightFileScopes: 2,
        providerDegradation: 0.1,
      },
    })

    assert.equal(model.observedAt, 123)
    assert.equal(model.phase, 'galaxy')
    assert.equal(model.health, 'degraded')
    assert.equal(model.attention, 'urgent')
    assert.equal(model.activeClaims, 3)
    assert.equal(model.signals[0]?.kind, 'worker_stalled')
  })

  it('is fail-closed for shutdown and neutral for missing snapshots', () => {
    const empty = buildRuntimeSelfModel({ now: 99 })
    assert.equal(empty.health, 'healthy')
    assert.equal(empty.confidence, 0.5)
    assert.deepEqual(empty.signals, [])

    const shuttingDown = buildRuntimeSelfModel({
      coordinator: { activeWorkers: 1, maxWorkers: 2, shuttingDown: true },
    })
    assert.equal(shuttingDown.health, 'blocked')
    assert.equal(shuttingDown.signals[0]?.kind, 'shutdown')
  })
})
