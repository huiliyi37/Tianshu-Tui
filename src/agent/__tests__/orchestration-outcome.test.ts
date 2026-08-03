import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildTeamOutcome } from '../orchestration-outcome.js'
import type { TeamRunSummary } from '../team-orchestrator.js'
import type { CoordinatorRun } from '../coordinator.js'
import type { PlanExecutorRun } from '../plan-executor.js'
import type { WorkerResult } from '../work-order.js'

function mkResult(over: Partial<WorkerResult> = {}): WorkerResult {
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

function mkRun(results: WorkerResult[]): CoordinatorRun {
  return { status: 'completed', results, packet: 'run' }
}

function mkSummary(over: Partial<TeamRunSummary> = {}): TeamRunSummary {
  return {
    mode: 'standard',
    planned: [],
    tasks: [],
    waves: [{ id: 'w0', taskIds: ['T1'], reason: 'r', parallelLimit: 1, risk: 'low' }],
    dispatched: 0,
    blocked: [],
    packet: '',
    ...over,
  }
}

test('run 缺席（未派发/预览）：workers.total === 0，不带 waveGate/reviewVerdict', () => {
  const summary = mkSummary({ dispatched: 0 }) // summary.run 缺席
  const outcome = buildTeamOutcome(summary, 0, {}) // run.gate/reviewVerdict 均缺席
  assert.equal(outcome.kind, 'team')
  assert.equal(outcome.dispatched, 0)
  assert.equal(outcome.workers.total, 0)
  assert.equal(outcome.workers.passed, 0)
  assert.equal('waveGate' in outcome, false)
  assert.equal('reviewVerdict' in outcome, false)
})

test('两个 worker 一过一败：workers = { total: 2, passed: 1 }', () => {
  const summary = mkSummary({
    dispatched: 2,
    run: mkRun([mkResult(), mkResult({ status: 'failed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, {})
  assert.deepEqual(outcome.workers, { total: 2, passed: 1 })
})

test('gate/reviewVerdict 透传：failures 原样、verdict 原样、waveGate 不含 wave', () => {
  const gate: PlanExecutorRun['gate'] = { wave: 0, passed: false, failures: ['npx tsc --noEmit — 3 errors'] }
  const summary = mkSummary({
    dispatched: 2,
    run: mkRun([mkResult(), mkResult({ status: 'passed', workOrderId: 'w2' })]),
  })
  const outcome = buildTeamOutcome(summary, 0, { gate, reviewVerdict: 'rejected' })
  assert.deepEqual(outcome.waveGate, { passed: false, failures: ['npx tsc --noEmit — 3 errors'] })
  assert.equal('wave' in outcome.waveGate!, false)
  assert.equal(outcome.reviewVerdict, 'rejected')
})

test('totalWaves 取 summary.waves.length，wave 取入参 fromWave', () => {
  const summary = mkSummary({ dispatched: 2, run: mkRun([mkResult()]) })
  const outcome = buildTeamOutcome(summary, 3, {})
  assert.equal(outcome.wave, 3)
  assert.equal(outcome.totalWaves, 1)
})
