import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import {
  buildTeamEpisode,
  deriveTeamEpisodeRewardInput,
  formatTeamDelivery,
  persistTeamEpisode,
  teamEpisodeKey,
  teamEpisodePersistKind,
} from '../team-episode.js'
import { buildTeamWaveRewardRecord, deriveTeamWaveRewardInput } from '../team-reward.js'

function fragment(overrides: Partial<TeamWaveTelemetry> = {}): TeamWaveTelemetry {
  const fromWave = overrides.fromWave ?? 0
  return {
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'obj',
    mode: 'standard',
    fromWave,
    waveId: `W${fromWave + 1}`,
    waveCount: 1,
    timestamp: 100 + fromWave,
    planned: {
      taskIds: [`T${fromWave + 1}`],
      risk: 'low',
      profiles: ['patcher'],
      authorities: ['tianliang'],
      files: [`src/${fromWave + 1}.ts`],
    },
    outcome: {
      dispatched: 1,
      statuses: [{ workOrderId: `team:T${fromWave + 1}`, status: 'passed', evidenceStatus: 'verified' }],
      verificationPassed: true,
      reviewVerdict: 'pass',
    },
    changedFiles: {
      observedChangedFiles: [`src/${fromWave + 1}.ts`],
      changedFilesSource: 'diff_artifact',
    },
    ...overrides,
  }
}

describe('team episode aggregation', () => {
  it('builds a complete single-wave episode with reward semantics matching team wave', () => {
    const wave = fragment({ timestamp: 10 })
    const episode = buildTeamEpisode([wave], { timestamp: 20 })

    assert.equal(episode.complete, true)
    assert.equal(episode.episodeKey, 'team_episode:obj:s1:standard:1')
    assert.deepEqual(episode.observedWaveIndexes, [0])
    assert.equal(teamEpisodeKey(episode), episode.episodeKey)

    const episodeReward = deriveTeamEpisodeRewardInput(episode)
    assert.ok(episodeReward)
    assert.deepEqual(episodeReward, deriveTeamWaveRewardInput(wave))
    assert.equal(buildTeamWaveRewardRecord(episodeReward).reward, 0.6)
  })

  it('stitches multi-wave fragments by fromWave, not arrival order', () => {
    const wave1 = fragment({ fromWave: 1, waveCount: 2, timestamp: 10, planned: { ...fragment().planned, taskIds: ['T2'], files: ['src/b.ts'] } })
    const wave0 = fragment({ fromWave: 0, waveCount: 2, timestamp: 20, planned: { ...fragment().planned, taskIds: ['T1'], files: ['src/a.ts'] } })

    const episode = buildTeamEpisode([wave1, wave0])

    assert.equal(episode.complete, true)
    assert.deepEqual(episode.observedWaveIndexes, [0, 1])
    assert.deepEqual(episode.fragments.map(fragment => fragment.telemetry.fromWave), [0, 1])
    assert.deepEqual(episode.planned.taskIds, ['T1', 'T2'])
  })

  it('does not derive reward for missing waves', () => {
    const episode = buildTeamEpisode([fragment({ fromWave: 1, waveCount: 2 })])

    assert.equal(episode.complete, false)
    assert.deepEqual(episode.missingWaveIndexes, [0])
    assert.equal(deriveTeamEpisodeRewardInput(episode), null)
  })

  it('does not silently overwrite duplicate fromWave fragments', () => {
    const episode = buildTeamEpisode([
      fragment({ fromWave: 0, waveCount: 2, timestamp: 10 }),
      fragment({ fromWave: 0, waveCount: 2, timestamp: 11 }),
      fragment({ fromWave: 1, waveCount: 2, timestamp: 12 }),
    ])

    assert.equal(episode.complete, false)
    assert.deepEqual(episode.duplicateWaveIndexes, [0])
    assert.equal(deriveTeamEpisodeRewardInput(episode), null)
  })

  it('keeps false-green negative when any fragment is false-green', () => {
    const episode = buildTeamEpisode([
      fragment({ fromWave: 0, waveCount: 2 }),
      fragment({
        fromWave: 1,
        waveCount: 2,
        outcome: {
          dispatched: 1,
          statuses: [{ workOrderId: 'team:T2', status: 'passed', evidenceStatus: 'unverified' }],
        },
      }),
    ])

    const reward = deriveTeamEpisodeRewardInput(episode)
    assert.ok(reward)
    assert.equal(reward.falseGreen, true)
    assert.ok(buildTeamWaveRewardRecord(reward).reward < 0)
  })

  it('recomputes scope leak with observed diff preferred over reported files', () => {
    const episode = buildTeamEpisode([
      fragment({
        changedFiles: {
          reportedChangedFiles: ['src/leak.ts'],
          observedChangedFiles: ['src/1.ts'],
          changedFilesSource: 'diff_artifact',
        },
      }),
    ])

    const reward = deriveTeamEpisodeRewardInput(episode)
    assert.ok(reward)
    assert.equal(reward.normalizedScopeLeak, 0)
  })

  it('persists append-only episode records while retaining stable logical episodeKey', () => {
    const first = buildTeamEpisode([fragment({ timestamp: 10 })], { timestamp: 20 })
    const second = buildTeamEpisode([fragment({ timestamp: 11 })], { timestamp: 21 })
    const calls: Array<{ kind: string; json: string }> = []

    persistTeamEpisode({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, first)
    persistTeamEpisode({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, second)

    assert.equal(calls.length, 2)
    assert.notEqual(calls[0]!.kind, calls[1]!.kind)
    assert.equal(JSON.parse(calls[0]!.json).episodeKey, 'team_episode:obj:s1:standard:1')
    assert.equal(JSON.parse(calls[1]!.json).episodeKey, 'team_episode:obj:s1:standard:1')
    assert.equal(calls[0]!.kind, teamEpisodePersistKind(first))
    assert.equal(calls[1]!.kind, teamEpisodePersistKind(second))
  })

  it('persist is no-op safe when store is missing or throws', () => {
    const episode = buildTeamEpisode([fragment()])

    assert.doesNotThrow(() => persistTeamEpisode(undefined, episode))
    assert.doesNotThrow(() => persistTeamEpisode({ saveBanditState: () => { throw new Error('db unavailable') } }, episode))
  })
})

describe('formatTeamDelivery', () => {
  it('renders per-wave tasks, cumulative changed files, and overall verdict', () => {
    const episode = buildTeamEpisode([
      fragment({ fromWave: 0, waveCount: 2, planned: { ...fragment().planned, taskIds: ['T1'] } }),
      fragment({ fromWave: 1, waveCount: 2, planned: { ...fragment().planned, taskIds: ['T2'] } }),
    ])
    const text = formatTeamDelivery(episode)
    assert.ok(text.includes('2/2 waves'), `wave count: ${text}`)
    assert.ok(text.includes('wave 1: T1'), 'wave 1 tasks')
    assert.ok(text.includes('wave 2: T2'), 'wave 2 tasks')
    assert.ok(text.includes('Changed files (2)'), 'cumulative changed files')
    assert.ok(text.includes('review=pass'), 'overall verdict')
  })

  it('surfaces files touched by multiple waves as a conflict face', () => {
    const shared = {
      observedChangedFiles: ['src/shared.ts'],
      changedFilesSource: 'diff_artifact' as const,
    }
    const episode = buildTeamEpisode([
      fragment({ fromWave: 0, waveCount: 2, changedFiles: shared }),
      fragment({ fromWave: 1, waveCount: 2, changedFiles: shared }),
    ])
    const text = formatTeamDelivery(episode)
    assert.ok(text.includes('touched by multiple waves'), `conflict line: ${text}`)
    assert.ok(text.includes('src/shared.ts'), 'conflict file listed')
  })
})
