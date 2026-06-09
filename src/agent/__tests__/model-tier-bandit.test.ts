import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHistoricalModelTierState,
  emptyModelTierBanditState,
  modelTierArmForTier,
  recommendModelTierArm,
} from '../model-tier-bandit.js'

function store(rowsByPrefix: Record<string, Array<{ kind: string; json: string }>>) {
  return {
    loadBanditStatesByPrefix: (prefix: string) => rowsByPrefix[prefix] ?? [],
  }
}

function shadow(model: string, tier: 'cheap' | 'balanced' | 'strong') {
  return JSON.stringify({
    schemaVersion: 1,
    sessionId: 's1',
    workOrderId: `team:${model}`,
    profile: 'code_scout',
    kind: 'code_search',
    recommendedTier: tier,
    actualModel: model,
    actualTier: tier,
    matched: true,
    reason: 'test',
    timestamp: 1,
  })
}

function reward(workerModel: string, value: number, extra: Record<string, number | boolean | string> = {}) {
  return JSON.stringify({
    schemaVersion: 1,
    id: `r:${workerModel}:${value}`,
    sourceKind: 'team_wave',
    sourceKey: `team_wave:${workerModel}`,
    sessionId: 's1',
    reward: value,
    components: { workerModel, ...extra },
    timestamp: 10,
  })
}

describe('model tier bandit', () => {
  it('aggregates reward closures through model tier shadow history', () => {
    const state = buildHistoricalModelTierState(store({
      'model_tier_shadow:': [
        { kind: 'model_tier_shadow:s1:team:T1:1', json: shadow('cheap-flash', 'cheap') },
        { kind: 'model_tier_shadow:s1:team:T2:1', json: shadow('balanced-worker', 'balanced') },
      ],
      'reward_closure:team_wave:': [
        { kind: 'reward_closure:team_wave:s1:1:a', json: reward('cheap-flash', 0.8) },
        { kind: 'reward_closure:team_wave:s1:2:b', json: reward('balanced-worker', 0.2) },
      ],
    }))

    assert.equal(state.totalSamples, 2)
    assert.equal(state.arms['tier:cheap'].samples, 1)
    assert.equal(state.arms['tier:cheap'].averageReward, 0.8)
    assert.equal(state.arms['tier:balanced'].averageReward, 0.2)
  })

  it('uses explicit workerTier reward component without truthy/falsy tier sentinels', () => {
    const state = buildHistoricalModelTierState(store({
      'model_tier_shadow:': [],
      'reward_closure:team_wave:': [
        { kind: 'reward_closure:team_wave:s1:1:a', json: reward('unknown-cheap', 0.75, { workerTier: 'cheap' }) },
      ],
    }))

    assert.equal(state.totalSamples, 1)
    assert.equal(state.arms[modelTierArmForTier('cheap')].samples, 1)
    assert.equal(recommendModelTierArm(state).tier, 'cheap')
  })

  it('ignores false-green closures instead of rewarding unsafe tiers', () => {
    const state = buildHistoricalModelTierState(store({
      'model_tier_shadow:': [{ kind: 'model_tier_shadow:s1:team:T1:1', json: shadow('cheap-flash', 'cheap') }],
      'reward_closure:team_wave:': [{ kind: 'reward_closure:team_wave:s1:1:a', json: reward('cheap-flash', 1, { falseGreen: true }) }],
    }))

    assert.equal(state.totalSamples, 0)
    assert.equal(state.recentFalseGreenRate, 1)
    assert.equal(recommendModelTierArm(state).confidence, 0)
  })

  it('derives scope-health veto state from real persisted scope health and reward closures', () => {
    const fromScopeHealth = buildHistoricalModelTierState(store({
      'model_tier_shadow:': [{ kind: 'model_tier_shadow:s1:team:T1:1', json: shadow('cheap-flash', 'cheap') }],
      'team_scope_health:': [{
        kind: 'team_scope_health:obj:s1:team_wave:1:x',
        json: JSON.stringify({ schemaVersion: 1, severity: 'high' }),
      }],
      'reward_closure:team_wave:': [{ kind: 'reward_closure:team_wave:s1:1:a', json: reward('cheap-flash', 1) }],
    }))
    assert.equal(fromScopeHealth.worstScopeHealthSeverity, 'high')

    const fromRewardClosure = buildHistoricalModelTierState(store({
      'model_tier_shadow:': [{ kind: 'model_tier_shadow:s1:team:T1:1', json: shadow('cheap-flash', 'cheap') }],
      'reward_closure:team_wave:': [{ kind: 'reward_closure:team_wave:s1:1:a', json: reward('cheap-flash', 1, { normalizedScopeLeak: 1 }) }],
    }))
    assert.equal(fromRewardClosure.worstScopeHealthSeverity, 'medium')
  })

  it('returns deterministic empty-state recommendation without inventing evidence', () => {
    const rec = recommendModelTierArm(emptyModelTierBanditState())
    assert.equal(rec.tier, 'cheap')
    assert.equal(rec.confidence, 0)
    assert.match(rec.reason, /no historical reward evidence/)
  })
})
