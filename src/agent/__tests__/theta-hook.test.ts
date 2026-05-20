import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createThetaRuntimeHook } from '../hooks/theta-hook.js'
import { createThetaState } from '../star-event.js'
import type { ThetaState } from '../star-event.js'
import type { Sensorium } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.8,
    complexity: 0.8,
    freshness: 0.5,
    stability: 0.9,
    ...overrides,
  }
}

function makeContext(sensorium: Sensorium | null = makeSensorium(), requests: string[] = []) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 4,
    recentToolHistory: [],
    sensorium,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  }, {
    requestThetaCheck: reason => { requests.push(reason) },
  })
}

describe('createThetaRuntimeHook', () => {
  it('advances theta state after every tool event', async () => {
    let state = createThetaState(7)
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(), { name: 'read_file', success: true })

    assert.equal(state.toolCallCount, 1)
    assert.equal(state.lastThetaAt, 0)
  })

  it('does not request theta when sensorium is unavailable', async () => {
    const requests: string[] = []
    let state = createThetaState(1)
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(null, requests), { name: 'read_file', success: true })

    assert.deepEqual(requests, [])
    assert.equal(state.toolCallCount, 1)
  })

  it('does not request theta for low complexity sensorium', async () => {
    const requests: string[] = []
    let state = createThetaState(1)
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium({ complexity: 0.2 }), requests), { name: 'read_file', success: true })

    assert.deepEqual(requests, [])
    assert.equal(state.toolCallCount, 1)
    assert.equal(state.lastThetaAt, 0)
  })

  it('does not request theta before interval is reached', async () => {
    const requests: string[] = []
    let state: ThetaState = { toolCallCount: 0, lastThetaAt: 0, interval: 3 }
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium(), requests), { name: 'read_file', success: true })

    assert.deepEqual(requests, [])
    assert.equal(state.toolCallCount, 1)
    assert.equal(state.lastThetaAt, 0)
  })

  it('requests theta-cycle and completes theta when interval is reached', async () => {
    const requests: string[] = []
    let state: ThetaState = { toolCallCount: 2, lastThetaAt: 0, interval: 3 }
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium(), requests), { name: 'edit_file', success: true })

    assert.deepEqual(requests, ['theta-cycle'])
    assert.equal(state.toolCallCount, 3)
    assert.equal(state.lastThetaAt, 3)
  })
})
