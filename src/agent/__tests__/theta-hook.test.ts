import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createThetaRuntimeHook } from '../hooks/theta-hook.js'
import { createThetaState, advanceThetaCounter } from '../star-event.js'
import type { ThetaState } from '../star-event.js'
import type { Sensorium } from '../sensorium.js'
import type { VigorState } from '../vigor.js'

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

function makeVigor(overrides: Partial<VigorState> = {}): VigorState {
  return {
    tonic: 0.5,
    phasic: 0,
    curiosity: 0.3,
    vigor: 0.5,
    variability: 0.2,
    history: [],
    ...overrides,
  }
}

function makeContext(
  sensorium: Sensorium | null = makeSensorium(),
  requests: string[] = [],
  vigor: VigorState | null = makeVigor(),
) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 4,
    recentToolHistory: [],
    sensorium,
    strategy: null,
    vigor,
    gitChangeRate: 0,
    season: null,
  }, {
    requestThetaCheck: reason => { requests.push(reason) },
  })
}

describe('createThetaRuntimeHook', () => {
  it('advances theta state and phase after every tool event', async () => {
    let state = createThetaState(7)
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(), { name: 'read_file', success: true })

    assert.equal(state.toolCallCount, 1)
    assert.equal(state.lastThetaAt, 0)
    assert.ok(state.phase > 0, 'phase should advance')
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
    // Phase is in retrieval (0.6) but interval not met (1 < 3)
    let state: ThetaState = { toolCallCount: 0, lastThetaAt: 0, interval: 3, phase: 0.6, cycleCount: 0 }
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium(), requests), { name: 'read_file', success: true })

    assert.deepEqual(requests, [])
    assert.equal(state.toolCallCount, 1)
    assert.equal(state.lastThetaAt, 0)
  })

  it('does not request theta when interval met but phase in encoding', async () => {
    const requests: string[] = []
    // Interval is met (2+1-0=3 >= 3) but phase is in encoding (0.2 < 0.5)
    let state: ThetaState = { toolCallCount: 2, lastThetaAt: 0, interval: 3, phase: 0.2, cycleCount: 0 }
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium(), requests), { name: 'edit_file', success: true })

    // Phase gate blocks — theta not requested
    assert.deepEqual(requests, [])
    assert.equal(state.toolCallCount, 3)
    assert.equal(state.lastThetaAt, 0)
  })

  it('requests theta-cycle and completes theta when both gates pass', async () => {
    const requests: string[] = []
    // Interval met (2+1-0=3 >= 3) AND phase in retrieval (0.7 >= 0.5)
    let state: ThetaState = { toolCallCount: 2, lastThetaAt: 0, interval: 3, phase: 0.7, cycleCount: 0 }
    const hook = createThetaRuntimeHook({
      getThetaState: () => state,
      setThetaState: next => { state = next },
    })

    await hook.run(makeContext(makeSensorium(), requests), { name: 'edit_file', success: true })

    assert.deepEqual(requests, ['theta-cycle:retrieval'])
    assert.equal(state.toolCallCount, 3)
    assert.equal(state.lastThetaAt, 3)
    assert.equal(state.phase, 0, 'phase should reset after completion')
    assert.equal(state.cycleCount, 1)
  })

  it('high vigor slows phase advance, delaying theta checks', () => {
    const base = createThetaState(10)
    const highVigor = advanceThetaCounter(base, { vigor: 0.9, complexity: 0.8 })
    const lowVigorState = createThetaState(10)
    const lowVigor = advanceThetaCounter(lowVigorState, { vigor: 0.1, complexity: 0.8 })

    assert.ok(highVigor.phase < lowVigor.phase,
      `high vigor phase ${highVigor.phase} should be < low vigor phase ${lowVigor.phase}`)
  })
})
