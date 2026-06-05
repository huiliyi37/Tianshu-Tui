import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  computeEFE,
  createPredictionAccumulator,
  recordPrediction,
  resetAccumulator,
  getErrorRate,
  getInterventionLevel,
  shouldTippingPointReset,
  adjustReasoningEffort,
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

  it('resetAccumulator clears predictions and consecutiveCorrect', () => {
    let acc = createPredictionAccumulator()
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, false)
    acc = recordPrediction(acc, true)
    assert.equal(acc.predictions.length, 3)
    assert.equal(acc.consecutiveCorrect, 1)

    acc = resetAccumulator(acc)

    assert.equal(acc.predictions.length, 0)
    assert.equal(acc.consecutiveCorrect, 0)
  })

  it('adjustReasoningEffort: escalate bumps 1 level', () => {
    assert.equal(adjustReasoningEffort('low', 'escalate'), 'medium')
    assert.equal(adjustReasoningEffort('medium', 'escalate'), 'high')
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

// ─── EFE (Expected Free Energy) Tests ─────────────────────────────

describe('computeEFE', () => {
  const baseAcc = createPredictionAccumulator(10)

  it('returns all four components in valid ranges', () => {
    const efe = computeEFE(baseAcc, 'genesis', {
      tonic: 0.6, phasic: 0.1, curiosity: 0.4, vigor: 0.7, variability: 0.1, history: [],
    }, {
      momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.4, freshness: 0.6, stability: 0.7,
    })
    assert.ok(efe.epistemicValue >= 0 && efe.epistemicValue <= 1)
    assert.ok(efe.pragmaticValue >= 0 && efe.pragmaticValue <= 1)
    assert.ok(efe.noveltyBonus >= 0 && efe.noveltyBonus <= 1)
    assert.ok(efe.precision >= 0.3 && efe.precision <= 1.0)
  })

  it('high uncertainty boosts epistemic value', () => {
    const lowConf = computeEFE(baseAcc, 'genesis', null, {
      momentum: 0.3, pressure: 0.4, confidence: 0.1, complexity: 0.5, freshness: 0.5, stability: 0.4,
    })
    const highConf = computeEFE(baseAcc, 'genesis', null, {
      momentum: 0.8, pressure: 0.2, confidence: 0.9, complexity: 0.2, freshness: 0.5, stability: 0.9,
    })
    assert.ok(lowConf.epistemicValue > highConf.epistemicValue)
  })

  it('wuwei season dampens pragmatic value', () => {
    const v = { tonic: 0.8, phasic: 0.2, curiosity: 0.3, vigor: 0.85, variability: 0.1, history: [] }
    const s = { momentum: 0.7, pressure: 0.2, confidence: 0.8, complexity: 0.3, freshness: 0.5, stability: 0.8 }
    const normal = computeEFE(baseAcc, 'return', v, s)
    const wuwei = computeEFE(baseAcc, 'wuwei', v, s)
    assert.ok(normal.pragmaticValue > wuwei.pragmaticValue)
  })

  it('high vigor drives high precision', () => {
    const high = computeEFE(baseAcc, 'genesis', {
      tonic: 0.9, phasic: 0.3, curiosity: 0.3, vigor: 0.95, variability: 0.05, history: [],
    }, null)
    const low = computeEFE(baseAcc, 'genesis', {
      tonic: 0.2, phasic: -0.5, curiosity: 0.3, vigor: 0.35, variability: 0.3, history: [],
    }, null)
    assert.ok(high.precision > low.precision)
  })

  it('gracefully degrades with null/undefined inputs', () => {
    const efe = computeEFE(baseAcc, null, null, null)
    assert.ok(efe.epistemicValue >= 0 && efe.epistemicValue <= 1)
    assert.ok(efe.pragmaticValue > 0.1 && efe.pragmaticValue < 0.7)
    assert.ok(efe.precision >= 0.3 && efe.precision <= 1.0)
  })

  it('low freshness + high curiosity → high novelty bonus', () => {
    const novel = computeEFE(baseAcc, 'genesis', {
      tonic: 0.5, phasic: 0, curiosity: 0.9, vigor: 0.5, variability: 0.1, history: [],
    }, {
      momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.4, freshness: 0.1, stability: 0.5,
    })
    const familiar = computeEFE(baseAcc, 'genesis', {
      tonic: 0.5, phasic: 0, curiosity: 0.1, vigor: 0.5, variability: 0.1, history: [],
    }, {
      momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.4, freshness: 0.9, stability: 0.5,
    })
    assert.ok(novel.noveltyBonus > familiar.noveltyBonus)
  })

  it('genesis season boosts epistemic vs return', () => {
    const s = { momentum: 0.5, pressure: 0.3, confidence: 0.5, complexity: 0.4, freshness: 0.5, stability: 0.5 }
    const genesis = computeEFE(baseAcc, 'genesis', null, s)
    const ret = computeEFE(baseAcc, 'return', null, s)
    assert.ok(genesis.epistemicValue >= ret.epistemicValue)
  })
})
