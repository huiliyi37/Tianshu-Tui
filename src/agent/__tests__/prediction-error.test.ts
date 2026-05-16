import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  createPredictionAccumulator,
  recordPrediction,
  getErrorRate,
  getInterventionLevel,
  shouldTippingPointReset,
  adjustReasoningEffort,
  type PredictionAccumulator,
} from '../prediction-error.js'

describe('PredictionAccumulator', () => {
  it('starts with zero error rate', () => {
    const acc = createPredictionAccumulator()
    assert.equal(getErrorRate(acc), 0)
  })

  it('computes error rate over sliding window', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, false)  // error
    assert.equal(getErrorRate(acc), 1 / 3)
  })

  it('sliding window drops old entries', () => {
    let acc = createPredictionAccumulator(3)
    acc = recordPrediction(acc, false)  // error (will be dropped)
    acc = recordPrediction(acc, false)  // error (will be dropped)
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    acc = recordPrediction(acc, true)   // correct
    // window = [true, true, true], old errors dropped
    assert.equal(getErrorRate(acc), 0)
  })

  it('intervention level: none when error rate < 0.4', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, false)
    // 1/2 = 0.5 but only 2 samples, need minimum 3
    assert.equal(getInterventionLevel(acc), 'none')
  })

  it('intervention level: hint when error rate >= 0.4', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, true)
    // 1/4 = 0.25 — still none
    assert.equal(getInterventionLevel(acc), 'none')

    acc = recordPrediction(acc, false)
    // 2/5 = 0.4 — hint
    assert.equal(getInterventionLevel(acc), 'hint')
  })

  it('intervention level: gate when error rate >= 0.6', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    // 2/3 ≈ 0.667
    assert.equal(getInterventionLevel(acc), 'gate')
  })

  it('intervention level: escalate when error rate >= 0.8', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, true)
    // 3/4 = 0.75 — still gate
    assert.equal(getInterventionLevel(acc), 'gate')

    acc = recordPrediction(acc, false)
    // 4/5 = 0.8 — escalate
    assert.equal(getInterventionLevel(acc), 'escalate')
  })

  it('returns none with fewer than 3 samples', () => {
    let acc = createPredictionAccumulator()
    acc = recordPrediction(acc, false)
    assert.equal(getInterventionLevel(acc), 'none')
    acc = recordPrediction(acc, false)
    assert.equal(getInterventionLevel(acc), 'none')
  })

  it('tipping point reset after 3 consecutive correct predictions', () => {
    let acc = createPredictionAccumulator(5)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    assert.equal(shouldTippingPointReset(acc), false)

    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    assert.equal(shouldTippingPointReset(acc), false)

    acc = recordPrediction(acc, true)
    assert.equal(shouldTippingPointReset(acc), true)
  })

  it('resets consecutive correct counter on error', () => {
    let acc = createPredictionAccumulator()
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    acc = recordPrediction(acc, true)
    assert.equal(shouldTippingPointReset(acc), true)

    acc = recordPrediction(acc, false)
    assert.equal(shouldTippingPointReset(acc), false)
    assert.equal(acc.consecutiveCorrect, 0)
  })

  it('adjustReasoningEffort: escalate bumps 2 levels', () => {
    assert.equal(adjustReasoningEffort('low', 'escalate'), 'high')
    assert.equal(adjustReasoningEffort('medium', 'escalate'), 'max')
    assert.equal(adjustReasoningEffort('high', 'escalate'), 'max')
  })

  it('adjustReasoningEffort: gate bumps 1 level', () => {
    assert.equal(adjustReasoningEffort('low', 'gate'), 'medium')
    assert.equal(adjustReasoningEffort('medium', 'gate'), 'high')
    assert.equal(adjustReasoningEffort('high', 'gate'), 'max')
  })

  it('adjustReasoningEffort: hint preserves current effort', () => {
    assert.equal(adjustReasoningEffort('low', 'hint'), 'low')
    assert.equal(adjustReasoningEffort('medium', 'hint'), 'medium')
    assert.equal(adjustReasoningEffort('high', 'hint'), 'high')
  })

  it('adjustReasoningEffort: none preserves current effort', () => {
    assert.equal(adjustReasoningEffort('low', 'none'), 'low')
    assert.equal(adjustReasoningEffort('medium', 'none'), 'medium')
    assert.equal(adjustReasoningEffort('max', 'none'), 'max')
  })
})
