import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { ModelRoutingShadowEvent } from '../model-routing-shadow.js'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import { buildTeamEpisode } from '../team-episode.js'
import {
  buildRewardClosureRecordFromRoutingShadow,
  buildRewardClosureRecordFromTeamEpisode,
  buildRewardClosureRecordFromTeamWave,
  persistRewardClosure,
  recordRoutingRewardClosure,
  recordTeamEpisodeRewardClosure,
  recordTeamWaveRewardClosure,
  rewardClosureKind,
} from '../reward-loop.js'

const routingEvent: ModelRoutingShadowEvent = {
  schemaVersion: 1,
  sessionId: 's1',
  turn: 2,
  objectiveHash: 'obj',
  currentModel: 'flash',
  selectedBy: 'config',
  legacyRouterRecommendedModel: 'pro',
  sensorium: { complexity: 0.4, pressure: 0.2, confidence: 0.8, stability: 0.7 },
  reason: 'shadow',
  timestamp: 100,
}

const teamEvent: TeamWaveTelemetry = {
  schemaVersion: 1,
  sessionId: 's1',
  objectiveHash: 'obj',
  mode: 'standard',
  fromWave: 0,
  waveId: 'W1',
  waveCount: 1,
  timestamp: 200,
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
    reviewVerdict: 'pass',
  },
  changedFiles: {
    observedChangedFiles: ['src/a.ts'],
    changedFilesSource: 'diff_artifact',
  },
  workerModels: [{ workOrderId: 'team:T1', model: 'pro' }],
}

describe('reward loop closure', () => {
  it('builds routing reward closures from routing shadow events', () => {
    const record = buildRewardClosureRecordFromRoutingShadow(routingEvent, { timestamp: 300 })

    assert.equal(record.sourceKind, 'routing_shadow')
    assert.equal(record.sourceKey, 'routing_shadow:s1:2:100')
    assert.equal(record.sessionId, 's1')
    assert.equal(record.objectiveHash, 'obj')
    assert.equal(record.components.currentModel, 'flash')
    assert.equal(record.components.recommendedModel, 'pro')
    assert.equal(record.reward, 0)
    assert.equal(rewardClosureKind(record), 'reward_closure:routing_shadow:s1:300:1f8e34a6')
  })

  it('builds team wave reward closures from team telemetry events', () => {
    const record = buildRewardClosureRecordFromTeamWave(teamEvent, { timestamp: 400 })

    assert.equal(record.sourceKind, 'team_wave')
    assert.equal(record.sourceKey, 'team_wave:obj:s1:0:200')
    assert.equal(record.sessionId, 's1')
    assert.equal(record.objectiveHash, 'obj')
    assert.equal(record.components.workerModelCount, 1)
    assert.equal(record.components.workerModel, 'pro')
    assert.equal(record.components.reviewVerdict, 'pass')
    assert.equal(record.reward, 0.6)
  })

  it('uses append-only keys for repeated closure of the same source event', () => {
    const first = buildRewardClosureRecordFromRoutingShadow(routingEvent, { timestamp: 301 })
    const second = buildRewardClosureRecordFromRoutingShadow(routingEvent, { timestamp: 302 })
    const replay = buildRewardClosureRecordFromRoutingShadow(routingEvent, { timestamp: 301 })

    assert.notEqual(rewardClosureKind(first), rewardClosureKind(second))
    assert.equal(rewardClosureKind(first), rewardClosureKind(replay))
  })

  it('keeps append-only keys unique when Date.now repeats', () => {
    const originalNow = Date.now
    Date.now = () => 1_000_000
    try {
      const first = buildRewardClosureRecordFromRoutingShadow(routingEvent)
      const second = buildRewardClosureRecordFromRoutingShadow(routingEvent)

      assert.equal(first.timestamp, 1_000_000)
      assert.equal(second.timestamp, 1_000_001)
      assert.notEqual(rewardClosureKind(first), rewardClosureKind(second))
    } finally {
      Date.now = originalNow
    }
  })

  it('builds team episode reward closures only for complete episodes', () => {
    const episode = buildTeamEpisode([teamEvent], { timestamp: 250 })
    const record = buildRewardClosureRecordFromTeamEpisode(episode, { timestamp: 450 })

    assert.ok(record)
    assert.equal(record.sourceKind, 'team_episode')
    assert.equal(record.sourceKey, 'team_episode:obj:s1:standard:1')
    assert.equal(record.sessionId, 's1')
    assert.equal(record.objectiveHash, 'obj')
    assert.equal(record.components.fragmentCount, 1)
    assert.equal(record.components.maxRisk, 'low')
    assert.equal(record.reward, 0.6)

    const incomplete = buildTeamEpisode([{ ...teamEvent, fromWave: 1, waveId: 'W2', waveCount: 2 }])
    assert.equal(buildRewardClosureRecordFromTeamEpisode(incomplete), null)
  })

  it('persists reward closures through saveBanditState and remains no-op safe', () => {
    const calls: Array<{ kind: string; json: string }> = []
    const record = buildRewardClosureRecordFromTeamWave(teamEvent, { timestamp: 500 })

    persistRewardClosure({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, record)

    assert.equal(calls.length, 1)
    assert.equal(calls[0]!.kind, 'reward_closure:team_wave:s1:500:94bc7f33')
    assert.equal(JSON.parse(calls[0]!.json).sourceKey, 'team_wave:obj:s1:0:200')
    assert.doesNotThrow(() => persistRewardClosure(undefined, record))
    assert.doesNotThrow(() => persistRewardClosure({ saveBanditState: () => { throw new Error('db unavailable') } }, record))
  })

  it('records routing and team closures without affecting callers when store throws', () => {
    const throwingStore = { saveBanditState: () => { throw new Error('db unavailable') } }

    assert.doesNotThrow(() => recordRoutingRewardClosure(throwingStore, routingEvent, { timestamp: 600 }))
    assert.doesNotThrow(() => recordTeamWaveRewardClosure(throwingStore, teamEvent, { timestamp: 601 }))
    assert.doesNotThrow(() => recordTeamEpisodeRewardClosure(throwingStore, buildTeamEpisode([teamEvent]), { timestamp: 602 }))
  })
})
