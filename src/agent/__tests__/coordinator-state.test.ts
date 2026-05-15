import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CoordinatorState } from '../coordinator-state.js'

describe('CoordinatorState', () => {
  it('tracks worker lifecycle events', () => {
    const state = new CoordinatorState(2)

    state.recordEvent({ type: 'queued', workOrderId: 'wo_1', timestamp: 1000 })
    state.recordEvent({ type: 'running', workOrderId: 'wo_1', timestamp: 1001 })
    state.recordEvent({ type: 'passed', workOrderId: 'wo_1', timestamp: 1002 })

    const events = state.getEvents()
    assert.equal(events.length, 3)
    assert.equal(events[0]!.type, 'queued')
    assert.equal(events[2]!.type, 'passed')
  })

  it('reports summary counts by status', () => {
    const state = new CoordinatorState(3)

    state.recordEvent({ type: 'queued', workOrderId: 'wo_1', timestamp: 1000 })
    state.recordEvent({ type: 'running', workOrderId: 'wo_1', timestamp: 1001 })
    state.recordEvent({ type: 'passed', workOrderId: 'wo_1', timestamp: 1002 })
    state.recordEvent({ type: 'queued', workOrderId: 'wo_2', timestamp: 1003 })
    state.recordEvent({ type: 'running', workOrderId: 'wo_2', timestamp: 1004 })
    state.recordEvent({ type: 'failed', workOrderId: 'wo_2', timestamp: 1005 })
    state.recordEvent({ type: 'queued', workOrderId: 'wo_3', timestamp: 1006 })
    state.recordEvent({ type: 'running', workOrderId: 'wo_3', timestamp: 1007 })
    state.recordEvent({ type: 'escalated', workOrderId: 'wo_3', timestamp: 1008 })

    const summary = state.getSummary()
    assert.equal(summary.queued, 3)
    assert.equal(summary.running, 3)
    assert.equal(summary.passed, 1)
    assert.equal(summary.failed, 1)
    assert.equal(summary.escalated, 1)
  })

  it('escalates when failure budget is exceeded', () => {
    const state = new CoordinatorState(2, { maxFailures: 2 })

    assert.equal(state.shouldEscalate(), false)
    state.recordEvent({ type: 'failed', workOrderId: 'wo_1', timestamp: 1000 })
    assert.equal(state.shouldEscalate(), false)
    state.recordEvent({ type: 'failed', workOrderId: 'wo_2', timestamp: 1001 })
    assert.equal(state.shouldEscalate(), true)
  })

  it('resets failure count on success', () => {
    const state = new CoordinatorState(2, { maxFailures: 2 })

    state.recordEvent({ type: 'failed', workOrderId: 'wo_1', timestamp: 1000 })
    state.recordEvent({ type: 'passed', workOrderId: 'wo_2', timestamp: 1001 })
    assert.equal(state.shouldEscalate(), false)
  })

  it('caps event history to prevent unbounded memory', () => {
    const state = new CoordinatorState(100)
    for (let i = 0; i < 200; i++) {
      state.recordEvent({ type: 'queued', workOrderId: `wo_${i}`, timestamp: i })
    }
    assert.equal(state.getEvents().length, 100)
  })
})
