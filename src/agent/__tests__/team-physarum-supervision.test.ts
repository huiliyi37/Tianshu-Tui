import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildTeamPhysarumSupervision,
  applyTeamPhysarumSupervision,
  teamPhysarumSupervisionPersistKind,
  persistTeamPhysarumSupervision,
  type TeamPhysarumSupervisionEvent,
} from '../team-physarum-supervision.js'
import type { TeamEpisode } from '../team-episode.js'
import type { TeamWaveTelemetry } from '../team-wave-telemetry.js'
import { buildTeamEpisode } from '../team-episode.js'
import { PhysarumEngine } from '../../repo/physarum-engine.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function fakeWaveTelemetry(overrides: Partial<TeamWaveTelemetry> = {}): TeamWaveTelemetry {
  return {
    schemaVersion: 1,
    sessionId: 's1',
    objectiveHash: 'abc123',
    mode: 'standard',
    fromWave: 0,
    waveId: 'w0',
    waveCount: 2,
    timestamp: Date.now(),
    planned: {
      taskIds: ['t1', 't2'],
      files: ['src/a.ts', 'src/b.ts'],
      profiles: ['scout'],
      authorities: [],
      risk: 'low' as const,
    },
    outcome: {
      dispatched: 2,
      statuses: [
        { workOrderId: 'w1', status: 'completed', evidenceStatus: 'passed' },
        { workOrderId: 'w2', status: 'completed', evidenceStatus: 'passed' },
      ],
      verificationPassed: true,
      reviewVerdict: 'pass',
    },
    changedFiles: {
      observedChangedFiles: ['src/a.ts', 'src/b.ts'],
      changedFilesSource: 'diff_artifact' as const,
    },
    ...overrides,
  }
}

function stubDb() {
  return {
    recordPhysarumPredictionObservation: () => {},
    savePhysarumEdges: () => {},
    loadPhysarumEdges: () => [] as any[],
  } as any
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('buildTeamPhysarumSupervision', () => {
  it('generates cross_wave edges for a complete healthy two-wave episode', () => {
    const wave0 = fakeWaveTelemetry({ fromWave: 0, waveCount: 2 })
    const wave1 = fakeWaveTelemetry({
      fromWave: 1,
      waveCount: 2,
      changedFiles: { observedChangedFiles: ['src/c.ts', 'src/d.ts'], changedFilesSource: 'diff_artifact' },
    })
    const episode = buildTeamEpisode([wave0, wave1])

    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, true)
    assert.ok(event.edges.length > 0, 'should produce cross-wave edges')
    for (const edge of event.edges) {
      assert.equal(edge.relation, 'cross_wave')
      assert.ok(edge.fromFile.endsWith('.ts'))
      assert.ok(edge.toFile.endsWith('.ts'))
    }
  })

  it('applies edges so predictNext can recommend the target file', () => {
    const wave0 = fakeWaveTelemetry({
      fromWave: 0,
      waveCount: 2,
      changedFiles: { observedChangedFiles: ['src/alpha.ts'], changedFilesSource: 'diff_artifact' },
    })
    const wave1 = fakeWaveTelemetry({
      fromWave: 1,
      waveCount: 2,
      changedFiles: { observedChangedFiles: ['src/beta.ts'], changedFilesSource: 'diff_artifact' },
    })
    const episode = buildTeamEpisode([wave0, wave1])
    const event = buildTeamPhysarumSupervision(episode, { apply: true })
    assert.equal(event.safeToApply, true)

    const engine = new PhysarumEngine(stubDb())
    applyTeamPhysarumSupervision(engine, event)
    const predictions = engine.predictNext('src/alpha.ts', 5)
    assert.ok(predictions.some(p => p.file === 'src/beta.ts'), 'should predict beta.ts from alpha.ts')
  })

  it('reports same-wave parallel tasks as skipped (no direction)', () => {
    // Same-wave parallel tasks: two fragments from same fromWave trigger
    // duplicateWaveIndexes → episode incomplete → safeToApply=false.
    // This is the correct guard — we never write direction for same-wave.
    const wave0a = fakeWaveTelemetry({
      fromWave: 0,
      waveId: 'w0a',
      waveCount: 1,
      planned: { taskIds: ['ta'], files: ['src/a.ts'], profiles: ['scout'], authorities: [], risk: 'low' },
      changedFiles: { observedChangedFiles: ['src/a.ts'], changedFilesSource: 'diff_artifact' },
    })
    const wave0b = fakeWaveTelemetry({
      fromWave: 0,
      waveId: 'w0b',
      waveCount: 1,
      planned: { taskIds: ['tb'], files: ['src/b.ts'], profiles: ['scout'], authorities: [], risk: 'low' },
      changedFiles: { observedChangedFiles: ['src/b.ts'], changedFilesSource: 'diff_artifact' },
    })
    const episode = buildTeamEpisode([wave0a, wave0b])

    // Duplicate wave 0 → incomplete episode
    assert.equal(episode.complete, false)
    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, false)
    // No directional edges for same-wave fragments
    assert.equal(event.edges.length, 0)
  })

  it('rejects episodes with failed or blocked statuses', () => {
    const wave0 = fakeWaveTelemetry({
      fromWave: 0,
      waveCount: 2,
      outcome: {
        dispatched: 2,
        statuses: [
          { workOrderId: 'w1', status: 'completed', evidenceStatus: 'passed' },
          { workOrderId: 'w2', status: 'failed', evidenceStatus: 'failed' },
        ],
      },
    })
    const wave1 = fakeWaveTelemetry({ fromWave: 1, waveCount: 2 })
    const episode = buildTeamEpisode([wave0, wave1])

    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, false)
    assert.ok(event.skipped.some(s => s.reason === 'failed_or_blocked_status'))
  })

  it('rejects episodes with high scope leak', () => {
    const wave0 = fakeWaveTelemetry({
      fromWave: 0,
      waveCount: 1,
      planned: {
        taskIds: ['t1'],
        files: ['src/a.ts'],
        profiles: ['scout'],
        authorities: [],
        risk: 'low',
      },
      changedFiles: {
        observedChangedFiles: [
          'src/a.ts',
          '.env.production',           // high-risk scope leak
          'src/auth/secrets.ts',       // high-risk scope leak
          'src/security/keys.ts',      // high-risk scope leak
        ],
        changedFilesSource: 'diff_artifact',
      },
    })
    const episode = buildTeamEpisode([wave0])

    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, false)
    assert.ok(event.skipped.some(s => s.reason === 'high_scope_leak'))
    assert.equal(event.scopeSeverity, 'high')
  })

  it('filters non-indexable files from edges', () => {
    const wave0 = fakeWaveTelemetry({
      fromWave: 0,
      waveCount: 2,
      changedFiles: {
        observedChangedFiles: ['src/ok.ts', 'node_modules/pkg/index.js', 'README.md'],
        changedFilesSource: 'diff_artifact',
      },
    })
    const wave1 = fakeWaveTelemetry({
      fromWave: 1,
      waveCount: 2,
      changedFiles: { observedChangedFiles: ['src/other.ts'], changedFilesSource: 'diff_artifact' },
    })
    const episode = buildTeamEpisode([wave0, wave1])

    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, true)
    for (const edge of event.edges) {
      assert.ok(edge.fromFile.endsWith('.ts'))
      assert.ok(!edge.fromFile.includes('node_modules'))
      assert.ok(!edge.fromFile.endsWith('.md'))
    }
  })

  it('rejects incomplete episodes', () => {
    const wave0 = fakeWaveTelemetry({ fromWave: 0, waveCount: 3 })
    // Only 1 of 3 waves — incomplete
    const episode = buildTeamEpisode([wave0])

    assert.equal(episode.complete, false)
    const event = buildTeamPhysarumSupervision(episode)
    assert.equal(event.safeToApply, false)
    assert.ok(event.skipped.some(s => s.reason === 'episode_incomplete'))
  })

  it('recordFlow happens before recordSequentialEdit during apply', () => {
    const calls: string[] = []
    const mockEngine = {
      recordFlow(_a: string, _b: string, _t: number) { calls.push('recordFlow') },
      recordSequentialEdit(_a: string, _b: string, _d: number) { calls.push('recordSequentialEdit') },
    }

    const event: TeamPhysarumSupervisionEvent = {
      schemaVersion: 1,
      sessionId: 's1',
      objectiveHash: 'abc',
      episodeKey: 'ep1',
      applied: true,
      safeToApply: true,
      edges: [
        {
          fromFile: 'src/a.ts', toFile: 'src/b.ts',
          relation: 'cross_wave',
          fromWaveId: '0', toWaveId: '1',
          sourceTaskIds: ['t1'], targetTaskIds: ['t2'],
          dtTurns: 1,
        },
      ],
      skipped: [],
      scopeSeverity: 'healthy',
      timestamp: Date.now(),
    }

    applyTeamPhysarumSupervision(mockEngine, event)
    // The first calls should be recordFlow before recordSequentialEdit
    const flowIdx = calls.indexOf('recordFlow')
    const seqIdx = calls.indexOf('recordSequentialEdit')
    assert.ok(flowIdx >= 0, 'recordFlow should be called')
    assert.ok(seqIdx >= 0, 'recordSequentialEdit should be called')
    assert.ok(flowIdx < seqIdx, 'recordFlow must precede recordSequentialEdit')
  })
})

describe('persistTeamPhysarumSupervision', () => {
  it('persists through saveBanditState and handles missing store safely', () => {
    const wave0 = fakeWaveTelemetry({ fromWave: 0, waveCount: 1 })
    const episode = buildTeamEpisode([wave0])
    const event = buildTeamPhysarumSupervision(episode)

    const calls: Array<{ kind: string; json: string }> = []
    persistTeamPhysarumSupervision({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, event)
    assert.equal(calls.length, 1)
    const parsed = JSON.parse(calls[0]!.json)
    assert.equal(parsed.schemaVersion, 1)
    assert.equal(parsed.episodeKey, event.episodeKey)

    // Duplicate persist: second call produces a different kind → different timestamp in event, but same
    // if we reuse the same event object it's identical. Test with a new event.
    const event2 = buildTeamPhysarumSupervision(episode, { timestamp: event.timestamp + 1 })
    persistTeamPhysarumSupervision({ saveBanditState: (kind, json) => { calls.push({ kind, json }) } }, event2)
    assert.equal(calls.length, 2)
    assert.notEqual(calls[0]!.kind, calls[1]!.kind, 'append-only: different timestamps must produce different keys')

    // No-op safety
    assert.doesNotThrow(() => persistTeamPhysarumSupervision(undefined, event))
    assert.doesNotThrow(() => persistTeamPhysarumSupervision({ saveBanditState: () => { throw new Error('db unavailable') } }, event))
  })

  it('persistKind is stable and append-only', () => {
    const wave0 = fakeWaveTelemetry({ fromWave: 0, waveCount: 1 })
    const episode = buildTeamEpisode([wave0])
    const event1 = buildTeamPhysarumSupervision(episode, { timestamp: 1000 })
    const event2 = buildTeamPhysarumSupervision(episode, { timestamp: 2000 })

    const k1 = teamPhysarumSupervisionPersistKind(event1)
    const k2 = teamPhysarumSupervisionPersistKind(event2)
    assert.ok(k1.startsWith('team_physarum_supervision:'))
    assert.notEqual(k1, k2, 'different timestamps → different persist keys')
  })

  it('does not crash when event has zero edges', () => {
    const wave0 = fakeWaveTelemetry({
      fromWave: 0,
      waveCount: 1,
      changedFiles: { observedChangedFiles: [], changedFilesSource: 'diff_artifact' },
    })
    const episode = buildTeamEpisode([wave0])
    const event = buildTeamPhysarumSupervision(episode)

    // Should still produce a valid event with 0 edges
    assert.equal(event.edges.length, 0)
    assert.doesNotThrow(() => {
      const kind = teamPhysarumSupervisionPersistKind(event)
      assert.ok(kind.includes('team_physarum_supervision:'))
    })
  })
})
