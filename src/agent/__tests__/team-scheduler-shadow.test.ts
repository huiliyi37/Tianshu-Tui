import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTeamSchedulerRewardEvent,
  buildTeamSchedulerShadowEvent,
  persistTeamSchedulerReward,
  persistTeamSchedulerShadow,
  teamSchedulerRewardKind,
  teamSchedulerShadowKind,
} from '../team-scheduler-shadow.js'

describe('team scheduler shadow telemetry', () => {
  it('builds append-only shadow events with pending reward ids', () => {
    const event = buildTeamSchedulerShadowEvent({
      sessionId: 's1',
      objective: 'do work',
      waveId: 'W1',
      ruleParallelism: 4,
      recommendedArm: 'parallelism:2',
      applied: false,
      gateOpen: true,
      reason: 'shadow: feature flag disabled',
      timestamp: 123,
    })

    assert.equal(event.schemaVersion, 1)
    assert.equal(event.pendingRewardId, `team_scheduler_reward:${event.objectiveHash}:s1:W1:123`)
    assert.equal(teamSchedulerShadowKind(event), 'team_scheduler_shadow:s1:W1:123')
  })

  it('builds scheduler reward records with false-green penalty components', () => {
    const event = buildTeamSchedulerRewardEvent({
      sessionId: 's1',
      objective: 'do work',
      waveId: 'W1',
      arm: 'parallelism:2',
      rewardInput: { teamWaveReward: 0.9, conflictRate: 0.5, scopeLeakRate: 0.5, falseGreen: true },
      timestamp: 124,
    })

    assert.equal(event.schemaVersion, 1)
    assert.equal(event.reward, 0)
    assert.equal(event.components.falseGreen, true)
    assert.equal(event.components.parallelism, 2)
    assert.equal(teamSchedulerRewardKind(event), 'team_scheduler_reward:s1:W1:124')
  })

  it('persists shadow and reward events without throwing on store failure', () => {
    const saved: string[] = []
    const shadow = buildTeamSchedulerShadowEvent({
      sessionId: 's1', objective: 'o', waveId: 'W1', ruleParallelism: 2, recommendedArm: 'parallelism:1', applied: false, gateOpen: false, reason: 'r', timestamp: 1,
    })
    const reward = buildTeamSchedulerRewardEvent({
      sessionId: 's1', objective: 'o', waveId: 'W1', arm: 'parallelism:1', rewardInput: { teamWaveReward: 1, conflictRate: 0, scopeLeakRate: 0, falseGreen: false }, timestamp: 2,
    })

    persistTeamSchedulerShadow({ saveBanditState: kind => { saved.push(kind) } }, shadow)
    persistTeamSchedulerReward({ saveBanditState: kind => { saved.push(kind) } }, reward)
    assert.deepEqual(saved, ['team_scheduler_shadow:s1:W1:1', 'team_scheduler_reward:s1:W1:2'])

    assert.doesNotThrow(() => persistTeamSchedulerShadow({ saveBanditState: () => { throw new Error('db down') } }, shadow))
    assert.doesNotThrow(() => persistTeamSchedulerReward({ saveBanditState: () => { throw new Error('db down') } }, reward))
  })
})
