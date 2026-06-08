import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildRoutingRewardRecord,
  computeRoutingReward,
} from '../routing-reward.js'

describe('routing reward', () => {
  it('rewards verified and reviewed routing outcomes', () => {
    const reward = computeRoutingReward({
      currentModel: 'pro',
      recommendedModel: 'pro',
      verificationPass: true,
      reviewPass: true,
      normalizedCostOverBudget: 0,
      normalizedLatencySurprisal: 0,
    })

    assert.ok(reward > 0.5)
    assert.equal(reward, 0.6)
  })

  it('keeps false-green significantly negative even when cost and latency are good', () => {
    const reward = computeRoutingReward({
      currentModel: 'flash',
      recommendedModel: 'flash',
      falseGreen: true,
      normalizedCostOverBudget: 0,
      normalizedLatencySurprisal: 0,
    })

    assert.ok(reward < -0.5)
    assert.equal(reward, -0.6)
  })

  it('clamps all normalized inputs and final reward to [-1, 1]', () => {
    const reward = computeRoutingReward({
      currentModel: 'flash',
      recommendedModel: 'pro',
      verificationPass: false,
      reviewPass: false,
      falseGreen: true,
      normalizedCostOverBudget: 99,
      normalizedLatencySurprisal: 99,
    })

    assert.equal(reward, -0.8)
  })

  it('does not invent success when review or verification are missing', () => {
    const record = buildRoutingRewardRecord({
      currentModel: 'flash',
      recommendedModel: 'pro',
      normalizedCostOverBudget: Number.NaN,
      normalizedLatencySurprisal: Number.POSITIVE_INFINITY,
    })

    assert.equal(record.reward, 0)
    assert.equal(record.components.reviewPass, 0)
    assert.equal(record.components.verificationPass, 0)
    assert.equal(record.components.normalizedCostOverBudget, 0)
    assert.equal(record.components.normalizedLatencySurprisal, 0)
    assert.equal(record.components.modelMatched, false)
    assert.equal(record.components.hasRecommendedModel, true)
    assert.equal(record.components.recommendedModel, 'pro')
  })

  it('preserves missing recommendation as missing rather than an empty-string sentinel', () => {
    const record = buildRoutingRewardRecord({ currentModel: 'flash' })

    assert.equal(record.components.hasRecommendedModel, false)
    assert.equal(Object.hasOwn(record.components, 'recommendedModel'), false)
    assert.equal(record.components.modelMatched, false)
  })
})
