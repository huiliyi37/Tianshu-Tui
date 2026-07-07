import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildHistoricalTeamSchedulerState,
  computeTeamSchedulerReward,
  createTeamSchedulerBandit,
  normalizeTeamSchedulerContext,
  recommendTeamSchedulerArm,
  summarizeTeamSchedulerBandit,
  teamSchedulerArmForParallelism,
  updateTeamSchedulerBandit,
  type TeamSchedulerContext,
} from '../team-scheduler-bandit.js'

const context: TeamSchedulerContext = {
  taskCount: 0.6,
  writeTaskCount: 0.4,
  readTaskCount: 0.2,
  dependencyDepth: 0.3,
  crossModuleScore: 0.5,
  highRiskRatio: 0.1,
  historicalReward: 0.2,
  scopeLeakRate: 0,
}

describe('team scheduler bandit', () => {
  it('normalizes context without guessing from free text', () => {
    assert.deepEqual(normalizeTeamSchedulerContext({
      taskCount: 2,
      writeTaskCount: -1,
      readTaskCount: 0.5,
      dependencyDepth: Number.NaN,
      crossModuleScore: 1.5,
      highRiskRatio: 0.25,
      historicalReward: -2,
      scopeLeakRate: 0.75,
    }), [1, 0, 0.5, 0, 1, 0.25, -1, 0.75])
  })

  it('uses scheduler-specific parallelism arms', () => {
    assert.equal(teamSchedulerArmForParallelism(0), 'parallelism:1')
    assert.equal(teamSchedulerArmForParallelism(4.8), 'parallelism:4')
    assert.equal(teamSchedulerArmForParallelism(99), 'parallelism:5')
  })

  it('maps team reward with conflict, scope leak, and false-green penalties', () => {
    assert.equal(computeTeamSchedulerReward({ teamWaveReward: 0.8, conflictRate: 0, scopeLeakRate: 0, falseGreen: false }), 0.8)
    assert.ok(Math.abs(computeTeamSchedulerReward({ teamWaveReward: 0.8, conflictRate: 1, scopeLeakRate: 1, falseGreen: true }) + 0.4) < 1e-12)
  })

  it('cold start recommends only as shadow evidence and records samples when updated', () => {
    const bandit = createTeamSchedulerBandit()
    const rec = recommendTeamSchedulerArm(bandit, context)
    assert.match(rec.arm, /^parallelism:[1-5]$/)

    updateTeamSchedulerBandit(bandit, 'parallelism:2', context, 0.7)
    updateTeamSchedulerBandit(bandit, 'parallelism:2', context, 0.5)

    const state = summarizeTeamSchedulerBandit(bandit)
    assert.equal(state.totalSamples, 2)
    assert.equal(state.arms['parallelism:2'].samples, 2)
    assert.equal(state.arms['parallelism:2'].averageReward, 0.6)
  })

  it('aggregates persisted scheduler reward records by arm', () => {
    const state = buildHistoricalTeamSchedulerState({
      loadBanditStatesByPrefix: prefix => {
        assert.equal(prefix, 'team_scheduler_reward:')
        return [
          { kind: 'team_scheduler_reward:s1:W1:1', json: JSON.stringify({ arm: 'parallelism:2', reward: 0.8 }) },
          { kind: 'team_scheduler_reward:s1:W2:2', json: JSON.stringify({ arm: 'parallelism:2', reward: 0.4 }) },
          { kind: 'team_scheduler_reward:s1:W3:3', json: JSON.stringify({ arm: 'parallelism:5', reward: -0.2 }) },
          { kind: 'team_scheduler_reward:s1:bad:4', json: JSON.stringify({ arm: 'executor_profile:patcher', reward: 1 }) },
        ]
      },
    })

    assert.equal(state.totalSamples, 3)
    assert.equal(state.arms['parallelism:2'].samples, 2)
    assert.equal(state.arms['parallelism:2'].averageReward, 0.6000000000000001)
    assert.equal(state.arms['parallelism:5'].samples, 1)
  })
})
