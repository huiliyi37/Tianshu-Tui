import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildWaveCheckpoint, executePlan } from '../plan-executor.js'
import { buildResumeFromCheckpoint, deriveTeamGroupId, loadCheckpoint, saveCheckpoint, type WaveCheckpoint } from '../wave-checkpoint.js'
import { deserializeUnifiedPlan } from '../unified-plan.js'
import type { TeamRunSummary } from '../team-orchestrator.js'
import type { TeamTask } from '../team-plan.js'
import type { WorkerResult } from '../work-order.js'
import { clearWaveResults } from '../wave-results-store.js'

// A1（TUI Team 闭环）：executePlan 每波完成落盘 checkpoint，全部通过后清除，
// 使 /team-resume 有真实的续跑数据源。

function mkTask(id: string, files: string[]): TeamTask {
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
    touchSet: [...files],
  }
}

function mkResult(workOrderId: string, status: WorkerResult['status'] = 'passed'): WorkerResult {
  return {
    workOrderId,
    status,
    summary: 'done',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    delegationDepth: 0,
  } as unknown as WorkerResult
}

describe('deriveTeamGroupId', () => {
  it('is deterministic and trims whitespace', () => {
    assert.equal(deriveTeamGroupId('fix auth'), deriveTeamGroupId('  fix auth  '))
    assert.notEqual(deriveTeamGroupId('fix auth'), deriveTeamGroupId('fix authz'))
    assert.match(deriveTeamGroupId('fix auth'), /^team-[0-9a-f]{8}$/)
  })
})

describe('buildWaveCheckpoint', () => {
  const summary: TeamRunSummary = {
    mode: 'standard',
    planned: [],
    tasks: [mkTask('T1', ['src/a.ts']), mkTask('T2', ['src/b.ts'])],
    waves: [
      { id: 'w0', taskIds: ['T1'], reason: '', parallelLimit: 3, risk: 'low' },
      { id: 'w1', taskIds: ['T2'], reason: '', parallelLimit: 3, risk: 'low' },
    ],
    dispatched: 1,
    blocked: [],
    packet: 'p',
    run: { status: 'completed', results: [mkResult('team:T1')], packet: 'p' },
  }

  it('derives remaining orders from waves after fromWave, with authority', () => {
    const cp = buildWaveCheckpoint({ objective: 'obj', fromWave: 0 }, summary, null)
    assert.equal(cp.groupId, deriveTeamGroupId('obj'))
    assert.equal(cp.lastCompletedWave, 0)
    assert.equal(cp.totalWaves, 2)
    assert.equal(cp.remainingOrders.length, 1)
    assert.equal(cp.remainingOrders[0]!.id, 'T2')
    assert.equal(cp.remainingOrders[0]!.authority, 'tianliang')
    assert.deepEqual(cp.remainingOrders[0]!.scope, { files: ['src/b.ts'] })
    assert.equal(cp.completedResults.length, 1)
  })

  it('accumulates prior completed results across waves', () => {
    const prior: WaveCheckpoint = {
      groupId: deriveTeamGroupId('obj'),
      timestamp: 1,
      lastCompletedWave: 0,
      completedResults: [mkResult('team:T0')],
      remainingOrders: [],
      objective: 'obj',
      totalWaves: 2,
    }
    const cp = buildWaveCheckpoint({ objective: 'obj', fromWave: 1 }, summary, prior)
    assert.deepEqual(cp.completedResults.map(r => r.workOrderId), ['team:T0', 'team:T1'])
    assert.equal(cp.remainingOrders.length, 0)
  })
})

describe('buildResumeFromCheckpoint (A2 /team-resume)', () => {
  const cp: WaveCheckpoint = {
    groupId: 'team-abc12345',
    timestamp: Date.now(),
    lastCompletedWave: 0,
    completedResults: [mkResult('team:T1'), mkResult('team:T2', 'failed')],
    remainingOrders: [
      { id: 'T3', objective: 'do T3', profile: 'patcher', kind: 'patch_proposal', scope: { files: ['src/c.ts'] }, authority: 'tianliang' },
    ],
    objective: 'resume objective',
    totalWaves: 2,
  }

  it('rebuilds remaining orders into a valid UnifiedPlan', () => {
    const resume = buildResumeFromCheckpoint(cp)
    assert.ok(resume)
    const plan = deserializeUnifiedPlan(resume!.planJson)
    assert.ok(plan)
    assert.equal(plan!.objective, 'resume objective')
    assert.equal(plan!.tasks.length, 1)
    assert.equal(plan!.tasks[0]!.id, 'T3')
    assert.deepEqual(plan!.tasks[0]!.files, ['src/c.ts'])
    assert.equal(plan!.tasks[0]!.profile, 'patcher')
  })

  it('prompt carries objective, completion summary, and failed-worker warning', () => {
    const resume = buildResumeFromCheckpoint(cp)!
    assert.match(resume.prompt, /\[TEAM RESUME\]/)
    assert.match(resume.prompt, /resume objective/)
    assert.match(resume.prompt, /1\/2 波/)
    assert.match(resume.prompt, /team:T2/)
    assert.match(resume.prompt, /team_orchestrate/)
    assert.match(resume.prompt, /不要传 planJson/)
  })

  it('returns null when no tasks remain', () => {
    assert.equal(buildResumeFromCheckpoint({ ...cp, remainingOrders: [] }), null)
  })
})

describe('executePlan checkpoint wiring', () => {
  const PLAN = `
### T1: First edit
修改 src/a.ts

### T2: Second edit
修改 src/a.ts
`

  it('saves a checkpoint after a non-final wave and clears it after a clean final wave', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-'))
    const objective = 'checkpoint wiring test'
    const groupId = deriveTeamGroupId(objective)
    const sessionId = `cp-test-${Date.now()}`
    try {
      // Wave 0 (same-file tasks serialize into 2 waves → not final).
      await executePlan(
        {
          mode: 'standard', objective, fromWave: 0, sessionId,
          reviewDepth: 0, cwd: dir, reviewGate: false, planMarkdown: PLAN,
        },
        { delegateBatch: async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId)), packet: 'w0' }) },
      )
      const cp = loadCheckpoint(dir, groupId)
      assert.ok(cp, 'checkpoint must exist after a non-final wave')
      assert.equal(cp!.lastCompletedWave, 0)
      assert.equal(cp!.totalWaves, 2)
      assert.equal(cp!.objective, objective)
      assert.ok(cp!.remainingOrders.length >= 1, 'remaining wave-1 task recorded')

      // Wave 1 (final, all passed) → checkpoint cleared.
      await executePlan(
        {
          mode: 'standard', objective, fromWave: 1, sessionId,
          reviewDepth: 0, cwd: dir, reviewGate: false, planMarkdown: PLAN,
        },
        { delegateBatch: async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId)), packet: 'w1' }) },
      )
      assert.equal(loadCheckpoint(dir, groupId), null, 'checkpoint cleared after clean delivery')
      assert.equal(existsSync(join(dir, '.rivet/checkpoints', `${groupId}.json`)), false)
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('keeps the checkpoint when the final wave has failures (resume scenario)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'rivet-cp-fail-'))
    const objective = 'checkpoint failure retention test'
    const groupId = deriveTeamGroupId(objective)
    const sessionId = `cp-fail-${Date.now()}`
    try {
      // Pre-seed a wave-0 checkpoint as if wave 0 already ran.
      saveCheckpoint(dir, {
        groupId, timestamp: Date.now(), lastCompletedWave: 0,
        completedResults: [mkResult('team:T1')], remainingOrders: [], objective, totalWaves: 2,
      })
      await executePlan(
        {
          mode: 'standard', objective, fromWave: 1, sessionId,
          reviewDepth: 0, cwd: dir, reviewGate: false, planMarkdown: PLAN,
        },
        { delegateBatch: async requests => ({ status: 'completed', results: requests.map(r => mkResult(r.parentTurnId, 'failed')), packet: 'w1' }) },
      )
      const cp = loadCheckpoint(dir, groupId)
      assert.ok(cp, 'checkpoint retained when the final wave failed')
      assert.equal(cp!.lastCompletedWave, 1)
      assert.ok(cp!.completedResults.some(r => r.status === 'failed'))
    } finally {
      clearWaveResults(sessionId)
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
