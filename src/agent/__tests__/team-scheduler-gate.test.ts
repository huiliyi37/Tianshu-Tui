import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyTeamSchedulerInfluence, evaluateTeamSchedulerGate } from '../team-scheduler-gate.js'
import type { TeamSchedulerBanditState } from '../team-scheduler-bandit.js'

function state(overrides: Partial<TeamSchedulerBanditState['arms']['parallelism:2']> = {}): TeamSchedulerBanditState {
  return {
    totalSamples: 35,
    arms: {
      'parallelism:1': { samples: 6, totalReward: 1.8, averageReward: 0.3 },
      'parallelism:2': { samples: 6, totalReward: 4.2, averageReward: 0.7, ...overrides },
      'parallelism:3': { samples: 6, totalReward: 3, averageReward: 0.5 },
      'parallelism:4': { samples: 6, totalReward: 2.4, averageReward: 0.4 },
      'parallelism:5': { samples: 11, totalReward: 3.3, averageReward: 0.3 },
    },
  }
}

describe('team scheduler gate', () => {
  it('keeps cold start closed', () => {
    const decision = evaluateTeamSchedulerGate({
      state: { ...state(), totalSamples: 3 },
      candidateArm: 'parallelism:2',
      ruleParallelism: 3,
      ruleBaselineReward: 0.4,
      recentFalseGreenRate: 0,
      ruleAgreementRate: 1,
      hardGateSafe: true,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.match(decision.reason, /total samples/)
    assert.equal(decision.evidenceWindow.source, 'team_scheduler_bandit')
    assert.deepEqual(decision.vetoSignals, ['insufficient_samples'])
  })

  it('opens on sufficient reward evidence but only shadows when feature flag is disabled', () => {
    const decision = evaluateTeamSchedulerGate({
      state: state(),
      candidateArm: 'parallelism:2',
      ruleParallelism: 3,
      ruleBaselineReward: 0.5,
      recentFalseGreenRate: 0,
      ruleAgreementRate: 0.9,
      hardGateSafe: true,
    })
    assert.equal(decision.gateOpen, true)
    assert.equal(decision.applied, false)
    assert.equal(decision.evidenceWindow.featureFlagEnabled, false)
    assert.deepEqual(decision.vetoSignals, ['explicit_flag_closed'])
    assert.equal(applyTeamSchedulerInfluence(3, 'parallelism:2', decision), 3)
  })

  it('applies only conservative down-parallelism when flag and gate are open', () => {
    const decision = evaluateTeamSchedulerGate({
      state: state(),
      candidateArm: 'parallelism:2',
      ruleParallelism: 4,
      ruleBaselineReward: 0.5,
      recentFalseGreenRate: 0,
      ruleAgreementRate: 0.9,
      hardGateSafe: true,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, true)
    assert.equal(decision.applied, true)
    assert.equal(applyTeamSchedulerInfluence(4, 'parallelism:2', decision), 2)
  })

  it('does not allow bandit to exceed deterministic rule parallelism', () => {
    const decision = evaluateTeamSchedulerGate({
      state: state(),
      candidateArm: 'parallelism:5',
      ruleParallelism: 3,
      ruleBaselineReward: 0.1,
      recentFalseGreenRate: 0,
      ruleAgreementRate: 1,
      hardGateSafe: true,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.match(decision.reason, /hard gate/)
  })

  it('false-green vetoes influence', () => {
    const decision = evaluateTeamSchedulerGate({
      state: state(),
      candidateArm: 'parallelism:2',
      ruleParallelism: 3,
      ruleBaselineReward: 0.5,
      recentFalseGreenRate: 0.01,
      ruleAgreementRate: 1,
      hardGateSafe: true,
      featureFlagEnabled: true,
    })
    assert.equal(decision.gateOpen, false)
    assert.equal(decision.applied, false)
    assert.match(decision.reason, /false-green/)
  })
})
