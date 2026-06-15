import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createVigorState,
  detectRigidity,
  modulateStrategyByVigor,
  shouldTriggerElmRelease,
  updateVigor,
} from '../vigor.js'
import type { Sensorium, StrategyProfile } from '../sensorium.js'
import type { PredictionAccumulator } from '../prediction-error.js'

function makeSensorium(overrides: Partial<Sensorium> = {}): Sensorium {
  return {
    momentum: 0.5,
    pressure: 0.3,
    confidence: 0.7,
    complexity: 0.3,
    freshness: 0.5,
    stability: 0.8,
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
  return {
    windowSize: 10,
    predictions,
    consecutiveCorrect: predictions.reduceRight((count, value) => value && count === predictions.length - 1 ? count + 1 : count, 0),
  }
}

describe('createVigorState', () => {
  it('returns a neutral initial state', () => {
    const state = createVigorState()

    assert.equal(state.tonic, 0.5)
    assert.equal(state.phasic, 0)
    assert.equal(state.curiosity, 0)
    assert.equal(state.vigor, 0.5)
    assert.equal(state.variability, 0)
    assert.deepEqual(state.history, [])
  })
})

describe('updateVigor', () => {
  it('raises tonic vigor after tool success', () => {
    const prev = createVigorState()
    const next = updateVigor(prev, { toolSuccess: true, sensorium: makeSensorium() })

    assert.ok(next.tonic > prev.tonic)
    assert.ok(next.vigor > prev.vigor)
  })

  it('lowers tonic vigor after tool failure', () => {
    const prev = createVigorState()
    const next = updateVigor(prev, { toolSuccess: false, sensorium: makeSensorium() })

    assert.ok(next.tonic < prev.tonic)
    assert.ok(next.vigor < prev.vigor)
  })

  it('produces positive phasic RPE when actual outcome beats baseline prediction', () => {
    const prev = createVigorState({ tonic: 0.35, vigor: 0.35 })
    const next = updateVigor(prev, { toolSuccess: true, sensorium: makeSensorium() })

    assert.ok(next.phasic > 0)
  })

  it('produces negative phasic RPE when actual outcome falls below baseline prediction', () => {
    const prev = createVigorState({ tonic: 0.8, vigor: 0.8 })
    const next = updateVigor(prev, { toolSuccess: false, sensorium: makeSensorium() })

    assert.ok(next.phasic < 0)
  })

  it('can derive tonic from PredictionAccumulator window success rate', () => {
    const prev = createVigorState({ tonic: 0.2, vigor: 0.2 })
    const predictionAcc = makePredictionAcc([true, true, true, false])
    const next = updateVigor(prev, { toolSuccess: true, sensorium: makeSensorium(), predictionAcc })

    assert.ok(next.tonic > prev.tonic)
    assert.ok(next.tonic < 0.75)
  })

  it('activates curiosity when complexity is high and confidence is low', () => {
    const prev = createVigorState()
    const next = updateVigor(prev, {
      toolSuccess: true,
      sensorium: makeSensorium({ complexity: 0.8, confidence: 0.2 }),
    })

    assert.ok(next.curiosity > 0)
  })

  it('does not activate curiosity when confidence is already high', () => {
    const prev = createVigorState()
    const next = updateVigor(prev, {
      toolSuccess: true,
      sensorium: makeSensorium({ complexity: 0.8, confidence: 0.8 }),
    })

    assert.equal(next.curiosity, 0)
  })

  it('clamps vigor output to 0..1', () => {
    let state = createVigorState({ tonic: 0.95, vigor: 0.95 })
    for (let i = 0; i < 20; i++) {
      state = updateVigor(state, { toolSuccess: true, sensorium: makeSensorium({ complexity: 0.9, confidence: 0.1 }) })
    }
    assert.ok(state.vigor <= 1)

    state = createVigorState({ tonic: 0.05, vigor: 0.05 })
    for (let i = 0; i < 20; i++) {
      state = updateVigor(state, { toolSuccess: false, sensorium: makeSensorium() })
    }
    assert.ok(state.vigor >= 0)
  })

  it('habituates: repeated successes produce diminishing positive phasic RPE', () => {
    let state = createVigorState()
    const phasics: number[] = []
    for (let i = 0; i < 10; i++) {
      state = updateVigor(state, { toolSuccess: true, sensorium: makeSensorium() })
      phasics.push(state.phasic)
    }

    assert.ok(phasics.at(-1)! < phasics[0]!)
  })

  it('tracks rolling vigor history and variability', () => {
    let state = createVigorState()
    state = updateVigor(state, { toolSuccess: true, sensorium: makeSensorium() })
    state = updateVigor(state, { toolSuccess: false, sensorium: makeSensorium() })

    assert.equal(state.history.length, 2)
    assert.ok(state.variability > 0)
  })
})

describe('detectRigidity', () => {
  it('returns false with insufficient history', () => {
    assert.equal(detectRigidity([0.5, 0.5, 0.5]), false)
  })

  it('flat-low: returns true when vigor plateaus at low/mid level', () => {
    assert.equal(detectRigidity(Array(10).fill(0.4)), true)
  })

  it('flat-high: returns false when vigor plateaus at high level (sustained success)', () => {
    assert.equal(detectRigidity(Array(10).fill(0.95)), false)
  })

  it('flat-at-boundary: returns true when mean is exactly at threshold', () => {
    assert.equal(detectRigidity(Array(10).fill(0.74)), true)
  })

  it('flat-above-boundary: returns false when mean exceeds high band', () => {
    assert.equal(detectRigidity(Array(10).fill(0.76)), false)
  })

  it('returns false when recent vigor varies normally', () => {
    assert.equal(detectRigidity([0.4, 0.6, 0.5, 0.7, 0.3, 0.6, 0.5, 0.4, 0.7, 0.5]), false)
  })
})

describe('modulateStrategyByVigor', () => {
  it('uses low vigor to become more cautious', () => {
    const strategy = makeStrategy({ reasoningEffort: 'medium', commitThreshold: 0.6, thetaCycleInterval: 7 })
    const vigor = createVigorState({ vigor: 0.2, phasic: -0.6 })
    const adjusted = modulateStrategyByVigor(strategy, vigor, makeSensorium())

    assert.equal(adjusted.reasoningEffort, 'high')
    assert.ok(adjusted.commitThreshold > strategy.commitThreshold)
    assert.ok(adjusted.thetaCycleInterval < strategy.thetaCycleInterval)
  })

  it('only allows high vigor to speed up when complexity is low and confidence is high', () => {
    const strategy = makeStrategy({ reasoningEffort: 'medium', commitThreshold: 0.8, thetaCycleInterval: 3 })
    const vigor = createVigorState({ vigor: 0.85, phasic: 0.4 })
    const adjusted = modulateStrategyByVigor(strategy, vigor, makeSensorium({ complexity: 0.2, confidence: 0.9 }))

    assert.equal(adjusted.reasoningEffort, 'low')
    assert.ok(adjusted.commitThreshold < strategy.commitThreshold)
    assert.ok(adjusted.thetaCycleInterval > strategy.thetaCycleInterval)
  })

  it('does not let high vigor override high complexity caution', () => {
    const strategy = makeStrategy({ reasoningEffort: 'high', commitThreshold: 0.8, thetaCycleInterval: 3 })
    const vigor = createVigorState({ vigor: 0.9, phasic: 0.5 })
    const adjusted = modulateStrategyByVigor(strategy, vigor, makeSensorium({ complexity: 0.9, confidence: 0.9 }))

    assert.equal(adjusted.reasoningEffort, 'high')
    assert.equal(adjusted.thetaCycleInterval, 3)
  })

  it('boosts exploration when curiosity is strong', () => {
    const strategy = makeStrategy({ explorationBreadth: 0.3 })
    const vigor = createVigorState({ curiosity: 0.8 })
    const adjusted = modulateStrategyByVigor(strategy, vigor, makeSensorium({ complexity: 0.8, confidence: 0.2 }))

    assert.ok(adjusted.explorationBreadth > strategy.explorationBreadth)
  })
})

describe('shouldTriggerElmRelease', () => {
  it('returns true after sustained high vigor', () => {
    const state = createVigorState({ vigor: 0.86, history: [0.81, 0.83, 0.84, 0.82, 0.86] })

    assert.equal(shouldTriggerElmRelease(state), true)
  })

  it('returns false when high vigor is not sustained', () => {
    const state = createVigorState({ vigor: 0.86, history: [0.4, 0.83, 0.5, 0.82, 0.86] })

    assert.equal(shouldTriggerElmRelease(state), false)
  })
})
