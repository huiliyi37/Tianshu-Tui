import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { CoordinatorRun } from '../coordinator.js'
import type { TeamTask } from '../team-plan.js'
import type { TeamWave } from '../team-grouping.js'
import {
  buildTeamWaveTelemetry,
  extractObservedChangedFilesFromArtifacts,
  persistTeamWaveTelemetry,
  teamWaveTelemetryKind,
} from '../team-wave-telemetry.js'

function teamTask(id: string, files: string[]): TeamTask {
  return {
    id,
    title: id,
    objective: `Implement ${id}`,
    files,
    profile: 'patcher',
    kind: 'patch_proposal',
    verification: [],
    dependsOn: [],
    riskTier: 'low',
    touchSet: files,
  }
}

function wave(id: string, taskIds: string[], risk: TeamWave['risk'] = 'low'): TeamWave {
  return { id, taskIds, reason: `${id} reason`, parallelLimit: 2, risk }
}

function run(overrides?: Partial<CoordinatorRun>): CoordinatorRun {
  return {
    status: 'completed',
    packet: 'packet',
    results: [],
    ...overrides,
  }
}

describe('team wave telemetry', () => {
  it('uses append-only team_wave keys rather than episode keys', () => {
    const base = { objectiveHash: 'abc123', sessionId: 's1', timestamp: 100 }
    const key0 = teamWaveTelemetryKind({ ...base, fromWave: 0 })
    const key1 = teamWaveTelemetryKind({ ...base, fromWave: 1 })

    assert.equal(key0, 'team_wave:abc123:s1:0:100')
    assert.equal(key1, 'team_wave:abc123:s1:1:100')
    assert.notEqual(key0, key1)
    assert.ok(!key0.startsWith('team_episode:'))
  })

  it('labels worker changedFiles as reportedChangedFiles, not actualFiles', () => {
    const task = teamTask('T1', ['src/a.ts'])
    const event = buildTeamWaveTelemetry({
      sessionId: 's1',
      objective: 'objective',
      mode: 'standard',
      fromWave: 0,
      wave: wave('W1', ['T1']),
      waves: [wave('W1', ['T1'])],
      taskMap: new Map([[task.id, task]]),
      run: run({
        results: [{
          workOrderId: 'team:T1',
          status: 'passed',
          summary: 'done',
          findings: [],
          artifacts: [],
          changedFiles: ['src/a.ts'],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
        }],
      }),
      timestamp: 10,
    })

    assert.equal(event.changedFiles.changedFilesSource, 'worker_result')
    assert.deepEqual(event.changedFiles.reportedChangedFiles, ['src/a.ts'])
    assert.equal(event.changedFiles.observedChangedFiles, undefined)
    assert.equal(Object.hasOwn(event.changedFiles, 'actualFiles'), false)
  })

  it('prefers observedChangedFiles from diff artifacts over worker self-report', () => {
    const task = teamTask('T1', ['src/a.ts'])
    const coordinatorRun = run({
      results: [{
        workOrderId: 'team:T1',
        status: 'passed',
        summary: 'done',
        findings: [],
        artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n' }],
        changedFiles: ['src/reported.ts'],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified',
      }],
    })

    assert.deepEqual(extractObservedChangedFilesFromArtifacts(coordinatorRun), ['src/a.ts'])

    const event = buildTeamWaveTelemetry({
      sessionId: 's1',
      objective: 'objective',
      mode: 'standard',
      fromWave: 0,
      wave: wave('W1', ['T1']),
      waves: [wave('W1', ['T1'])],
      taskMap: new Map([[task.id, task]]),
      run: coordinatorRun,
      timestamp: 10,
    })

    assert.equal(event.changedFiles.changedFilesSource, 'diff_artifact')
    assert.deepEqual(event.changedFiles.reportedChangedFiles, ['src/reported.ts'])
    assert.deepEqual(event.changedFiles.observedChangedFiles, ['src/a.ts'])
  })

  it('records planned/outcome fields and worker model metadata for a wave fragment', () => {
    const task = teamTask('T1', ['src/a.ts', 'src/a.test.ts'])
    const event = buildTeamWaveTelemetry({
      sessionId: 's1',
      objective: 'objective',
      mode: 'standard',
      fromWave: 1,
      wave: wave('W2', ['T1'], 'medium'),
      waves: [wave('W1', ['T0']), wave('W2', ['T1'])],
      taskMap: new Map([[task.id, task]]),
      run: run({
        workerModels: [{ workOrderId: 'team:T1', model: 'pro' }],
        modelTierShadows: [{
          schemaVersion: 1,
          sessionId: 's1',
          workOrderId: 'team:T1',
          profile: 'patcher',
          kind: 'patch_proposal',
          recommendedTier: 'cheap',
          actualModel: 'pro',
          actualTier: 'strong',
          matched: false,
          reason: 'low-risk patcher observed as cheap',
          timestamp: 9,
        }],
        results: [{
          workOrderId: 'team:T1',
          status: 'passed',
          summary: 'done',
          findings: [],
          artifacts: [],
          changedFiles: [],
          risks: [],
          nextActions: [],
          evidenceStatus: 'verified',
          verification: { command: 'npx tsc --noEmit', status: 'passed', scope: 'targeted', exitCode: 0, passed: 1, failed: 0, skipped: 0, durationMs: 12 },
        }],
      }),
      dispatched: 1,
      timestamp: 10,
    })

    assert.equal(event.waveId, 'W2')
    assert.equal(event.waveCount, 2)
    assert.equal(event.planned.risk, 'medium')
    assert.deepEqual(event.planned.taskIds, ['T1'])
    assert.deepEqual(event.planned.profiles, ['patcher'])
    assert.deepEqual(event.planned.files, ['src/a.test.ts', 'src/a.ts'])
    assert.deepEqual(event.outcome.statuses, [{ workOrderId: 'team:T1', status: 'passed', evidenceStatus: 'verified' }])
    assert.equal(event.outcome.verificationPassed, true)
    assert.deepEqual(event.workerModels, [{ workOrderId: 'team:T1', model: 'pro' }])
    assert.deepEqual(event.workerModelTierShadows, [{
      workOrderId: 'team:T1',
      recommendedTier: 'cheap',
      actualTier: 'strong',
      matched: false,
      reason: 'low-risk patcher observed as cheap',
    }])
  })

  it('records per-task dependencies and per-task changed files for supervision consumers', () => {
    const task1 = teamTask('T1', ['src/a.ts'])
    const task2: TeamTask = { ...teamTask('T2', ['src/b.ts']), dependsOn: ['T1'] }
    const event = buildTeamWaveTelemetry({
      sessionId: 's1',
      objective: 'objective',
      mode: 'standard',
      fromWave: 1,
      wave: wave('W2', ['T1', 'T2']),
      waves: [wave('W1', ['T1']), wave('W2', ['T2'])],
      taskMap: new Map([[task1.id, task1], [task2.id, task2]]),
      run: run({
        results: [
          {
            workOrderId: 'team:T1',
            status: 'passed',
            summary: 'done T1',
            findings: [],
            artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/a.ts b/src/a.ts\n--- a/src/a.ts\n+++ b/src/a.ts\n@@\n' }],
            changedFiles: ['src/a-reported.ts'],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified',
          },
          {
            workOrderId: 'team:T2',
            status: 'passed',
            summary: 'done T2',
            findings: [],
            artifacts: [{ kind: 'diff', title: 'Patch', content: 'diff --git a/src/b.ts b/src/b.ts\n--- a/src/b.ts\n+++ b/src/b.ts\n@@\n' }],
            changedFiles: ['src/b-reported.ts'],
            risks: [],
            nextActions: [],
            evidenceStatus: 'verified',
          },
        ],
      }),
      timestamp: 10,
    })

    assert.deepEqual(event.planned.taskDependencies, [{ taskId: 'T2', dependsOn: ['T1'] }])
    assert.deepEqual(event.changedFiles.reportedChangedFilesByTask, [
      { taskId: 'T1', files: ['src/a-reported.ts'] },
      { taskId: 'T2', files: ['src/b-reported.ts'] },
    ])
    assert.deepEqual(event.changedFiles.observedChangedFilesByTask, [
      { taskId: 'T1', files: ['src/a.ts'] },
      { taskId: 'T2', files: ['src/b.ts'] },
    ])
  })

  it('persist is no-op safe when store is missing or throws', () => {
    const task = teamTask('T1', [])
    const event = buildTeamWaveTelemetry({
      sessionId: 's1',
      objective: 'objective',
      mode: 'standard',
      fromWave: 0,
      wave: wave('W1', ['T1']),
      waves: [wave('W1', ['T1'])],
      taskMap: new Map([[task.id, task]]),
      run: run(),
      timestamp: 10,
    })

    assert.doesNotThrow(() => persistTeamWaveTelemetry(undefined, event))
    assert.doesNotThrow(() => persistTeamWaveTelemetry({ saveBanditState: () => { throw new Error('db unavailable') } }, event))
  })
})
