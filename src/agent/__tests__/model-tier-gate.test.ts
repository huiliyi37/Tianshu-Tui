import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { evaluateModelTierGate } from '../model-tier-gate.js'
import type { ModelTierBanditState } from '../model-tier-bandit.js'

function state(overrides: Partial<ModelTierBanditState> = {}): ModelTierBanditState {
  return {
    totalSamples: 35,
    arms: {
      'tier:cheap': { samples: 10, totalReward: 8, averageReward: 0.8 },
      'tier:balanced': { samples: 15, totalReward: 7.5, averageReward: 0.5 },
      'tier:strong': { samples: 10, totalReward: 4, averageReward: 0.4 },
    },
    recentFalseGreenRate: 0,
    ...overrides,
  }
}

describe('model tier gate', () => {
  it('keeps cold start closed even when feature flag is enabled', () => {
    const decision = evaluateModelTierGate({
      state: state({ totalSamples: 3 }),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'balanced', reason: 'rule' },
      recentFalseGreenRate: 0,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.equal(decision.effectiveTier, 'balanced')
    assert.match(decision.reason, /total samples/)
    assert.equal(decision.evidenceWindow.source, 'model_tier_bandit')
    assert.deepEqual(decision.vetoSignals, ['insufficient_samples'])
  })

  it('opens with sufficient evidence but remains shadow-only when flag is disabled', () => {
    const decision = evaluateModelTierGate({
      state: state(),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'balanced', reason: 'rule' },
      recentFalseGreenRate: 0,
    })
    assert.equal(decision.gateOpen, true)
    assert.equal(decision.applied, false)
    assert.equal(decision.effectiveTier, 'balanced')
    assert.equal(decision.evidenceWindow.featureFlagEnabled, false)
    assert.deepEqual(decision.vetoSignals, ['explicit_flag_closed'])
  })

  it('applies cheap as a valid candidate when flag and evidence allow it', () => {
    const decision = evaluateModelTierGate({
      state: state(),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'balanced', reason: 'rule' },
      recentFalseGreenRate: 0,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, true)
    assert.equal(decision.applied, true)
    assert.equal(decision.effectiveTier, 'cheap')
  })

  it('blocks candidates below hardFloor', () => {
    const decision = evaluateModelTierGate({
      state: state(),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'strong', hardFloor: 'strong', reason: 'verification' },
      recentFalseGreenRate: 0,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.equal(decision.effectiveTier, 'strong')
    assert.match(decision.reason, /hardFloor strong blocks cheap/)
  })

  it('vetoes false-green and high scope-health signals', () => {
    const falseGreen = evaluateModelTierGate({
      state: state(),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'balanced', reason: 'rule' },
      recentFalseGreenRate: 0.01,
      featureFlagEnabled: true,
    })
    assert.equal(falseGreen.applied, false)
    assert.match(falseGreen.reason, /false-green/)
    assert.deepEqual(falseGreen.vetoSignals, ['false_green'])

    const scope = evaluateModelTierGate({
      state: state(),
      candidateArm: 'tier:cheap',
      ruleRecommendation: { tier: 'balanced', reason: 'rule' },
      recentFalseGreenRate: 0,
      scopeHealthSeverity: 'high',
      featureFlagEnabled: true,
    })
    assert.equal(scope.applied, false)
    assert.match(scope.reason, /scope-health veto high/)
    assert.deepEqual(scope.vetoSignals, ['scope_health'])
  })
})
