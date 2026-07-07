import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createTeamOrchestrateTool } from '../team-orchestrate.js'
import { createPlanTaskTool } from '../plan-task.js'
import type { CoordinatorRun, DelegationCoordinator, DelegationRequest } from '../../agent/coordinator.js'
import type { PlanExecutorDeps } from '../../agent/plan-executor.js'
import { storePlan, consumePlan, getStoredPlan } from '../../agent/plan-store.js'
import { getWaveResults, clearWaveResults } from '../../agent/wave-results-store.js'

type RunResult = CoordinatorRun['results'][number]

function mkResult(over: Partial<RunResult> = {}): RunResult {
  return {
    workOrderId: 'w',
    status: 'passed',
    summary: 's',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...over,
  }
}

function run(results: RunResult[] = [], packet = 'stub'): CoordinatorRun {
  return { status: 'completed', results, packet }
}

function twoWavePlan(sessionId: string): string {
  // T2 depends on T1 → grouping yields wave0=[T1], wave1=[T2].
  return JSON.stringify({
    version: 1,
    objective: 'bridge two waves',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
      { id: 'T2', title: 'edit bar', objective: 'Modify src/agent/bar.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/bar.ts'], dependsOn: ['T1'], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
}

// ── plan_task writes wave results to the session-scoped store ─────────────

test('plan_task(execute:true) records wave results into the session store', async () => {
  const sessionId = 'bridge-plan-write'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const executorDeps: PlanExecutorDeps = {
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:S1', status: 'passed' })], 'plan-wave0'),
  }
  const tool = createPlanTaskTool({
    getCoordinator: () => ({}) as unknown as DelegationCoordinator,
    getExecutorDeps: () => executorDeps,
    getSessionId: () => sessionId,
  })

  const result = await tool.execute({
    input: { objective: 'refactor the cache module for clarity and add tests', execute: true },
    cwd: process.cwd(),
    toolUseId: 'pt-bridge',
    sessionId,
  })

  assert.notEqual(result.isError, true)
  const stored = getWaveResults(sessionId)
  assert.ok(stored, 'plan_task should write its wave results to the session store')
  assert.equal(stored!.length, 1)
  assert.equal(stored![0]!.workOrderId, 'team:S1')
})

// ── cross-tool bridge: a failed wave-0 result blocks a dependent wave-1 task
//    across SEPARATE tool instances (the old per-instance closure could not). ──

test('wave-0 failure bridges across tool instances to block the dependent wave-1 task', async () => {
  const sessionId = 'bridge-cross-tool'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // Simulate plan_task's bridge: the serialized plan is in the session store.
  storePlan(twoWavePlan(sessionId), sessionId)

  // Wave 0 (tool instance A): dispatch T1, report it FAILED.
  const toolA = createTeamOrchestrateTool({
    delegateBatch: async () => run([mkResult({ workOrderId: 'team:T1', status: 'failed', summary: 'crashed' })], 'wave0'),
  })
  const r0 = await toolA.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 0', fromWave: 0 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-0',
    sessionId,
  })
  assert.equal(r0.isError, false)
  const stored = getWaveResults(sessionId)
  assert.ok(stored && stored.length === 1 && stored[0]!.status === 'failed', 'wave-0 failure should be stored session-scoped')

  // Wave 1 (a DIFFERENT tool instance): auto-consume the plan, read prior results
  // from the store, and block T2 because its dependency T1 failed.
  let captured: DelegationRequest[] = []
  const toolB = createTeamOrchestrateTool({
    delegateBatch: async requests => { captured = requests; return run([], 'wave1') },
  })
  const r1 = await toolB.execute({
    input: { mode: 'standard', objective: 'force: bridge wave 1', fromWave: 1 },
    cwd: process.cwd(),
    toolUseId: 'tu-bridge-1',
    sessionId,
  })
  assert.equal(r1.isError, false)
  assert.ok(!captured.some(req => req.parentTurnId.includes('T2')), 'T2 must be blocked by the bridged wave-0 failure')
})

// ── Phase D: an explicit planJson clears any stale stored plan ──────────────

test('explicit planJson clears a stale stored plan and is not re-stored', async () => {
  const sessionId = 'bridge-stale-clean'
  clearWaveResults(sessionId)
  consumePlan(sessionId)
  // A stale plan left over from a prior run.
  storePlan('STALE-NOT-VALID-JSON', sessionId)

  const explicit = JSON.stringify({
    version: 1,
    objective: 'explicit run',
    tasks: [
      { id: 'T1', title: 'edit foo', objective: 'Modify src/agent/foo.ts', profile: 'patcher', kind: 'patch_proposal', files: ['src/agent/foo.ts'], dependsOn: [], riskTier: 'low' },
    ],
    source: 'plan_task',
    createdAt: Date.now(),
  })
  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'explicit') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: run explicit plan', planJson: explicit },
    cwd: process.cwd(),
    toolUseId: 'tu-stale',
    sessionId,
  })

  assert.equal(result.isError, false)
  // Stale plan dropped; explicit planJson takes priority and is NOT re-stored.
  assert.equal(getStoredPlan(sessionId), null)
})

// ── Phase D: clear error when standard mode has nothing to run ──────────────

test('team_orchestrate reports a clear error when no plan is provided or stored', async () => {
  const sessionId = 'bridge-no-plan'
  clearWaveResults(sessionId)
  consumePlan(sessionId)

  const tool = createTeamOrchestrateTool({ delegateBatch: async () => run([], 'nope') })
  const result = await tool.execute({
    input: { mode: 'standard', objective: 'force: nothing to orchestrate here at all' },
    cwd: process.cwd(),
    toolUseId: 'tu-noplan',
    sessionId,
  })

  assert.equal(result.isError, true)
  assert.match(result.content, /No plan provided and no stored plan found/)
})
