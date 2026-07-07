import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildModelPolicyCandidates,
  computeModelG,
  selectModelPolicy,
  type ModelPolicyCandidate,
} from '../model-policy-selection.js'
import type { EFEComponents } from '../prediction-error.js'
import type { Sensorium } from '../sensorium.js'
import type { ModelCapabilityCard } from '../../model/capability.js'

const calmSensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'> = {
  complexity: 0.1,
  pressure: 0.05,
  confidence: 0.95,
  stability: 0.9,
}

const hardSensorium: Pick<Sensorium, 'complexity' | 'pressure' | 'confidence' | 'stability'> = {
  complexity: 0.9,
  pressure: 0.85,
  confidence: 0.25,
  stability: 0.35,
}

const calmEFE: EFEComponents = {
  epistemicValue: 0.1,
  pragmaticValue: 0.4,
  noveltyBonus: 0.1,
  precision: 0.9,
}

const hardEFE: EFEComponents = {
  epistemicValue: 0.85,
  pragmaticValue: 0.25,
  noveltyBonus: 0.2,
  precision: 0.7,
}

function candidate(overrides: Partial<ModelPolicyCandidate> & { model: string }): ModelPolicyCandidate {
  return {
    model: overrides.model,
    tier: overrides.tier ?? 'balanced',
    estimatedCost: overrides.estimatedCost ?? 0.5,
    estimatedLatency: overrides.estimatedLatency ?? 0.5,
    predictedSuccess: overrides.predictedSuccess ?? 0.8,
    riskFit: overrides.riskFit ?? 0.8,
    ...(overrides.authorityFit !== undefined ? { authorityFit: overrides.authorityFit } : {}),
    ...(overrides.historicalReward !== undefined ? { historicalReward: overrides.historicalReward } : {}),
  }
}

describe('model policy selection', () => {
  it('ranks cheap first for low-complexity high-confidence low-pressure turns', () => {
    const selected = selectModelPolicy({
      candidates: [
        candidate({ model: 'strong-pro', tier: 'strong', estimatedCost: 0.9, estimatedLatency: 0.7, predictedSuccess: 0.9, riskFit: 0.92 }),
        candidate({ model: 'cheap-flash', tier: 'cheap', estimatedCost: 0.1, estimatedLatency: 0.1, predictedSuccess: 0.82, riskFit: 0.86 }),
      ],
      efe: calmEFE,
      sensorium: calmSensorium,
    })

    assert.equal(selected[0]?.model, 'cheap-flash')
  })

  it('ranks strong first for high-complexity low-confidence high-pressure turns', () => {
    const selected = selectModelPolicy({
      candidates: [
        candidate({ model: 'cheap-flash', tier: 'cheap', estimatedCost: 0.1, estimatedLatency: 0.1, predictedSuccess: 0.7, riskFit: 0.65 }),
        candidate({ model: 'strong-pro', tier: 'strong', estimatedCost: 0.9, estimatedLatency: 0.7, predictedSuccess: 0.92, riskFit: 0.96 }),
      ],
      efe: hardEFE,
      sensorium: hardSensorium,
    })

    assert.equal(selected[0]?.model, 'strong-pro')
  })

  it('penalizes negative historical reward enough to lower the candidate ranking', () => {
    const selected = selectModelPolicy({
      candidates: [
        candidate({ model: 'model-a', historicalReward: -0.8 }),
        candidate({ model: 'model-b', historicalReward: 0.2 }),
      ],
      efe: calmEFE,
      sensorium: calmSensorium,
    })

    assert.equal(selected[0]?.model, 'model-b')
  })

  it('does not let cost advantage cover obvious false-green failure risk', () => {
    const selected = selectModelPolicy({
      candidates: [
        candidate({ model: 'cheap-risky', tier: 'cheap', estimatedCost: 0, estimatedLatency: 0, predictedSuccess: 0.48, riskFit: 0.18 }),
        candidate({ model: 'strong-safe', tier: 'strong', estimatedCost: 1, estimatedLatency: 0.8, predictedSuccess: 0.9, riskFit: 0.95 }),
      ],
      efe: hardEFE,
      sensorium: hardSensorium,
    })

    assert.equal(selected[0]?.model, 'strong-safe')
  })

  it('clamps non-finite and out-of-range scores into stable finite G values', () => {
    const g = computeModelG({
      candidate: candidate({
        model: 'unstable-input',
        estimatedCost: Number.POSITIVE_INFINITY,
        estimatedLatency: -2,
        predictedSuccess: 9,
        riskFit: Number.NaN,
        historicalReward: -9,
      }),
      efe: { epistemicValue: 9, pragmaticValue: -1, noveltyBonus: Number.NaN, precision: 2 },
      sensorium: { complexity: 9, pressure: Number.NaN, confidence: -1, stability: 2 },
    })

    assert.equal(Number.isFinite(g), true)
    assert.ok(g >= -3 && g <= 3)
  })

  it('uses deterministic model-name tie break for identical candidates', () => {
    const selected = selectModelPolicy({
      candidates: [candidate({ model: 'z-model' }), candidate({ model: 'a-model' })],
      efe: calmEFE,
      sensorium: calmSensorium,
    })

    assert.deepEqual(selected.map(s => s.model), ['a-model', 'z-model'])
  })

  it('builds candidates from ModelCapabilityCard without consuming routing behavior', () => {
    const cards: ModelCapabilityCard[] = [
      { model: 'MiniMax-M2.7', toolUseReliability: 0.7, jsonStability: 0.7, editSuccessRate: 0.6, testRepairRate: 0.5, contextWindow: 204_800, cacheEconomics: 'weak', recommendedTasks: [] },
      { model: 'gpt-5.5-pro', toolUseReliability: 0.95, jsonStability: 0.9, editSuccessRate: 0.92, testRepairRate: 0.88, contextWindow: 1_000_000, cacheEconomics: 'strong', recommendedTasks: [] },
    ]

    const candidates = buildModelPolicyCandidates(cards, { historicalRewards: { 'gpt-5.5-pro': 0.5 } })

    assert.deepEqual(candidates.map(c => c.model), ['MiniMax-M2.7', 'gpt-5.5-pro'])
    assert.equal(candidates[0]?.tier, 'cheap')
    assert.equal(candidates[1]?.tier, 'strong')
    assert.equal(candidates[1]?.historicalReward, 0.5)
    assert.ok(candidates.every(c => c.estimatedCost >= 0 && c.estimatedCost <= 1))
  })
})
