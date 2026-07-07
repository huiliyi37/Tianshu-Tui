import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import { buildTeamEpisode } from '../team-episode.js'
import {
  buildTeamEpisodeScopeHealth,
  buildTeamWaveScopeHealth,
  isHighRiskScopePath,
  persistTeamScopeHealth,
  teamScopeHealthPersistKind,
} from '../team-scope-health.js'

function wave(overrides: Partial<TeamWaveTelemetry> = {}): TeamWaveTelemetry {
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

describe('team scope health', () => {
  it('prefers observed changed files over worker report', () => {
    const health = buildTeamWaveScopeHealth(wave({
      changedFiles: {
        reportedChangedFiles: ['src/leak.ts'],
        observedChangedFiles: ['src/a.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.deepEqual(health.actualFiles, ['src/a.ts'])
    assert.equal(health.changedFilesSource, 'diff_artifact')
    assert.deepEqual(health.leakedFiles, [])
    assert.equal(health.severity, 'healthy')
  })

  it('detects leaked observed diff when worker self-report is empty', () => {
    const health = buildTeamWaveScopeHealth(wave({
      changedFiles: {
        reportedChangedFiles: [],
        observedChangedFiles: ['src/unplanned.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.deepEqual(health.leakedFiles, ['src/unplanned.ts'])
    assert.equal(health.scopeLeakRate, 1)
    assert.equal(health.severity, 'medium')
  })

  it('treats actual files without planned scope as high severity', () => {
    const health = buildTeamWaveScopeHealth(wave({
      planned: { ...wave().planned, files: [] },
      changedFiles: {
        observedChangedFiles: ['src/a.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.equal(health.scopeLeakRate, 1)
    assert.equal(health.coverageRate, 0)
    assert.equal(health.severity, 'high')
  })

  it('keeps missing-only as low severity, not scope leak', () => {
    const health = buildTeamWaveScopeHealth(wave({
      planned: { ...wave().planned, files: ['src/a.ts', 'src/b.ts'] },
      changedFiles: {
        observedChangedFiles: ['src/a.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.deepEqual(health.missingFiles, ['src/b.ts'])
    assert.deepEqual(health.leakedFiles, [])
    assert.equal(health.scopeLeakRate, 0)
    assert.equal(health.severity, 'low')
  })

  it('raises high severity for high-risk leaked paths', () => {
    assert.equal(isHighRiskScopePath('src/config/schema.ts'), true)
    assert.equal(isHighRiskScopePath('src/prompt/static.ts'), true)
    assert.equal(isHighRiskScopePath('src/feature.ts'), false)

    const health = buildTeamWaveScopeHealth(wave({
      changedFiles: {
        observedChangedFiles: ['src/config/schema.ts'],
        changedFilesSource: 'diff_artifact',
      },
    }))

    assert.equal(health.severity, 'high')
    assert.deepEqual(health.leakedFiles, ['src/config/schema.ts'])
  })

  it('computes episode scope health from global planned and actual files', () => {
    const episode = buildTeamEpisode([
      wave({
        fromWave: 1,
        waveId: 'W2',
        waveCount: 2,
        planned: { ...wave().planned, taskIds: ['T2'], files: ['src/b.ts'] },
        changedFiles: { observedChangedFiles: ['src/b.ts', 'src/leak.ts'], changedFilesSource: 'diff_artifact' },
      }),
      wave({
        fromWave: 0,
        waveId: 'W1',
        waveCount: 2,
        planned: { ...wave().planned, taskIds: ['T1'], files: ['src/a.ts'] },
        changedFiles: { observedChangedFiles: ['src/a.ts'], changedFilesSource: 'diff_artifact' },
      }),
    ])

    const health = buildTeamEpisodeScopeHealth(episode)

    assert.equal(health.sourceKind, 'team_episode')
    assert.deepEqual(health.plannedFiles, ['src/a.ts', 'src/b.ts'])
    assert.deepEqual(health.actualFiles, ['src/a.ts', 'src/b.ts', 'src/leak.ts'])
    assert.equal(health.scopeLeakRate, 1 / 3)
    assert.equal(health.severity, 'medium')
  })

  it('uses append-only persistence keys', () => {
    const first = buildTeamWaveScopeHealth(wave({ timestamp: 10 }), { timestamp: 20 })
    const second = buildTeamWaveScopeHealth(wave({ timestamp: 10 }), { timestamp: 21 })
    const calls: Array<{ kind: string; json: string }> = []

    persistTeamScopeHealth({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, first)
    persistTeamScopeHealth({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, second)

    assert.notEqual(calls[0]!.kind, calls[1]!.kind)
    assert.equal(calls[0]!.kind, teamScopeHealthPersistKind(first))
    assert.equal(JSON.parse(calls[0]!.json).sourceKey, first.sourceKey)
    assert.doesNotThrow(() => persistTeamScopeHealth(undefined, first))
    assert.doesNotThrow(() => persistTeamScopeHealth({ saveBanditState: () => { throw new Error('db unavailable') } }, first))
  })
})
