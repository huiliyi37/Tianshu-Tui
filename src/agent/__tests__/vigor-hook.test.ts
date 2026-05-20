import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createRuntimeHookContext,
} from '../runtime-hooks.js'
import type { RuntimeHookContext } from '../runtime-hooks.js'
import {
  createVigorAfterPerceptionHook,
  createVigorPostToolHook,
} from '../hooks/vigor-hook.js'
import { createVigorState } from '../vigor.js'
import type { VigorState } from '../vigor.js'
import type { PredictionAccumulator } from '../prediction-error.js'
import type { Sensorium, StrategyProfile } from '../sensorium.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.8,
    complexity: 0.2,
    freshness: 0.5,
    stability: 0.9,
    ...overrides,
  }
}

function makeStrategy(overrides: Partial<StrategyProfile> = {}): StrategyProfile {
  return {
    reasoningEffort: 'medium',
    explorationBreadth: 0.3,
    commitThreshold: 0.6,
    shouldEscalate: false,
    thetaCycleInterval: 7,
    ...overrides,
  }
}

function makePredictionAcc(predictions: boolean[]): PredictionAccumulator {
  return { windowSize: 10, predictions, consecutiveCorrect: 0 }
}

function makeContext(options: {
  sensorium?: Sensorium | null
  strategy?: StrategyProfile | null
  vigor?: VigorState | null
  setVigor?: (vigor: VigorState) => void
  setStrategy?: (strategy: StrategyProfile) => void
  requestThetaCheck?: (reason: string) => void
} = {}): RuntimeHookContext {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn: 2,
    recentToolHistory: [],
    sensorium: options.sensorium === undefined ? makeSensorium() : options.sensorium,
    strategy: options.strategy === undefined ? makeStrategy() : options.strategy,
    vigor: options.vigor === undefined ? createVigorState() : options.vigor,
    gitChangeRate: 0,
    season: null,
  }, {
    setVigor: options.setVigor,
    setStrategy: options.setStrategy,
    requestThetaCheck: options.requestThetaCheck,
  })
}

describe('createVigorPostToolHook', () => {
  it('updates vigor from a successful tool result', async () => {
    const observed: { value: VigorState | null } = { value: null }
    const hook = createVigorPostToolHook({
      getPredictionAccumulator: () => makePredictionAcc([true, true, false]),
    })
    const ctx = makeContext({
      vigor: createVigorState(),
      setVigor: vigor => { observed.value = vigor },
    })

    await hook.run(ctx, { name: 'read_file', success: true, target: 'src/a.ts' })

    assert.ok(observed.value)
    assert.ok(observed.value.vigor > 0.5)
    assert.ok(observed.value.history.length > 0)
  })

  it('updates vigor from a failed tool result', async () => {
    const observed: { value: VigorState | null } = { value: null }
    const hook = createVigorPostToolHook({
      getPredictionAccumulator: () => makePredictionAcc([true, true, true]),
    })
    const ctx = makeContext({
      vigor: createVigorState({ tonic: 0.8, vigor: 0.8 }),
      setVigor: vigor => { observed.value = vigor },
    })

    await hook.run(ctx, { name: 'bash', success: false, isError: true })

    assert.ok(observed.value)
    assert.ok(observed.value.vigor < 0.8)
    assert.ok(observed.value.phasic < 0)
  })

  it('does nothing until sensorium is available', async () => {
    let called = false
    const hook = createVigorPostToolHook({
      getPredictionAccumulator: () => makePredictionAcc([true]),
    })
    const ctx = makeContext({
      sensorium: null,
      setVigor: () => { called = true },
    })

    await hook.run(ctx, { name: 'read_file', success: true })

    assert.equal(called, false)
  })
})

describe('createVigorAfterPerceptionHook', () => {
  it('modulates strategy using current vigor after perception', async () => {
    const observed: { value: StrategyProfile | null } = { value: null }
    const hook = createVigorAfterPerceptionHook()
    const ctx = makeContext({
      sensorium: makeSensorium({ complexity: 0.2, confidence: 0.9 }),
      strategy: makeStrategy({ reasoningEffort: 'medium', thetaCycleInterval: 3 }),
      vigor: createVigorState({ vigor: 0.85, phasic: 0.4 }),
      setStrategy: strategy => { observed.value = strategy },
    })

    await hook.run(ctx)

    assert.ok(observed.value)
    assert.equal(observed.value.reasoningEffort, 'low')
    assert.ok(observed.value.thetaCycleInterval > 3)
  })

  it('does nothing until sensorium, strategy, and vigor are all available', async () => {
    let called = false
    const hook = createVigorAfterPerceptionHook()
    const ctx = makeContext({
      vigor: null,
      setStrategy: () => { called = true },
    })

    await hook.run(ctx)

    assert.equal(called, false)
  })

  it('requests an ELM theta pulse after sustained high vigor', async () => {
    const requests: string[] = []
    const hook = createVigorAfterPerceptionHook()
    const ctx = makeContext({
      vigor: createVigorState({ vigor: 0.86, history: [0.82, 0.83, 0.84, 0.85, 0.86] }),
      requestThetaCheck: reason => { requests.push(reason) },
    })

    await hook.run(ctx)

    assert.deepEqual(requests, ['elm-micro-release'])
  })
})
