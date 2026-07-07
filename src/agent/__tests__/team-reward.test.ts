import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import {
  buildTeamWaveRewardRecord,
  computeTeamWaveReward,
  deriveTeamWaveRewardInput,
} from '../team-reward.js'

function event(overrides?: Partial<TeamWaveTelemetry>): TeamWaveTelemetry {
  return {
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'obj',
    mode: 'standard',
    fromWave: 0,
    waveId: 'W1',
    waveCount: 1,
    timestamp: 10,
    planned: {
      taskIds: ['T1'],
      risk: 'low',
      profiles: ['patcher'],
      authorities: ['tianliang'],
      files: ['src/a.ts'],
    },
    outcome: {
      dispatched: 1,
      statuses: [{ workOrderId: 'team:T1', status: 'passed', evidenceStatus: 'verified' }],
      verificationPassed: true,
    },
    changedFiles: {
      observedChangedFiles: ['src/a.ts'],
      changedFilesSource: 'diff_artifact',
    },
    ...overrides,
  }
}

describe('team wave reward', () => {
  it('rewards verified and reviewed wave outcomes', () => {
    const reward = computeTeamWaveReward({
      verificationPass: true,
      reviewPass: true,
      normalizedConflict: 0,
      normalizedRework: 0,
      normalizedScopeLeak: 0,
      normalizedCostOverBudget: 0,
      normalizedLatencySurprisal: 0,
      falseGreen: false,
    })

    assert.ok(reward > 0.5)
    assert.equal(reward, 0.6)
  })

  it('keeps worst case below -0.5 and clamps final reward', () => {
    const reward = computeTeamWaveReward({
      verificationPass: false,
      reviewPass: false,
      normalizedConflict: 5,
      normalizedRework: 5,
      normalizedScopeLeak: 5,
      normalizedCostOverBudget: 5,
      normalizedLatencySurprisal: 5,
      falseGreen: true,
    })

    assert.equal(reward, -1)
  })

  it('keeps false-green significantly negative even when cost and latency are good', () => {
    const reward = computeTeamWaveReward({
      normalizedConflict: 0,
      normalizedRework: 0,
      normalizedScopeLeak: 0,
      normalizedCostOverBudget: 0,
      normalizedLatencySurprisal: 0,
      falseGreen: true,
    })

    assert.ok(reward < -0.5)
    assert.equal(reward, -0.6)
  })

  it('derives scope leak from changed files outside planned files', () => {
    const input = deriveTeamWaveRewardInput(event({
      changedFiles: {
        reportedChangedFiles: ['src/a.ts', 'src/unplanned.ts'],
        changedFilesSource: 'worker_result',
      },
    }))

    assert.equal(input.normalizedScopeLeak, 0.5)
  })

  it('prefers observed changed files over worker self-report when deriving scope leak', () => {
    const input = deriveTeamWaveRewardInput(event({
      changedFiles: {
        reportedChangedFiles: ['src/unplanned.ts'],
        observedChangedFiles: ['src/a.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.equal(input.normalizedScopeLeak, 0)
  })

  it('detects false-green from passed statuses with unverified evidence', () => {
    const input = deriveTeamWaveRewardInput(event({
      outcome: {
        dispatched: 1,
        statuses: [{ workOrderId: 'team:T1', status: 'passed', evidenceStatus: 'unverified' }],
      },
    }))

    assert.equal(input.falseGreen, true)
    assert.equal(input.verificationPass, undefined)
    const record = buildTeamWaveRewardRecord(input)
    assert.equal(record.components.verificationObserved, false)
    assert.equal(record.components.reviewObserved, false)
    assert.equal(record.reward, -0.6)
  })
})
