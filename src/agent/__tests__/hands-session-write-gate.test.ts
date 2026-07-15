import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { runHandsSession, type HandsSessionConfig } from '../hands-session.js'
import { WorktreeCoordinator } from '../worktree-coordinator.js'
import { createWriteWorkOrder, type WorkOrder } from '../work-order.js'
import type { EvaluateWorkerWriteGateInput, WorkerWriteGateReport } from '../worker-write-gate.js'

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

function testOrder(overrides: Partial<WorkOrder> = {}): WorkOrder {
  return createWriteWorkOrder({
    parentTurnId: 'turn-1',
    kind: 'patch_proposal',
    profile: 'patcher',
    objective: 'Write a test file',
    scope: { files: ['src/output.ts'] },
    ...overrides,
  })
}

function workerJson(order: WorkOrder, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    workOrderId: order.id,
    status: 'passed',
    summary: 'wrote the file',
    findings: [],
    artifacts: [],
    changedFiles: ['src/output.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'verified',
    ...extra,
  })
}

function report(outcome: WorkerWriteGateReport['outcome'], overrides: Partial<WorkerWriteGateReport> = {}): WorkerWriteGateReport {
  return { outcome, checks: [], evidence: outcome === 'passed' ? [] : ['❌ tsc — TS0000'], falseGreen: false, declaredFalseGreen: false, ...overrides }
}

describe('runHandsSession × worker write gate (W4-D1)', () => {
  let baseDir: string
  let wtCoordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-hands-gate-'))
    initGitRepo(baseDir)
    wtCoordinator = new WorktreeCoordinator(baseDir)
  })

  after(() => {
    wtCoordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  function baseConfig(order: WorkOrder, overrides: Partial<HandsSessionConfig> = {}): HandsSessionConfig {
    return {
      order,
      wtCoordinator,
      cwd: baseDir,
      maxTurns: 2,
      contextWindow: 128_000,
      compact: { enabled: false, autoThreshold: 800_000, autoFloor: 500_000, model: 'flash' },
      writeGateEnabled: true,
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const hello = 1\n')
        execSync('git add -A && git commit -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
        return workerJson(order)
      },
      ...overrides,
    }
  }

  it('gate passed → result untouched, writeGate reported with 0 repairs', async () => {
    const order = testOrder({ id: 'wo-gate-pass' })
    const run = await runHandsSession(baseConfig(order, {
      evaluateWriteGate: async () => report('passed'),
    }))
    assert.equal(run.result.status, 'passed')
    assert.equal(run.writeGate?.report.outcome, 'passed')
    assert.equal(run.writeGate?.repairCount, 0)
  })

  it('gate failed → ONE bounded repair by the same worker; repair passing → passed', async () => {
    const order = testOrder({ id: 'wo-gate-repair' })
    const prompts: string[] = []
    let evaluations = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (prompt, _callbacks, workerCwd) => {
        prompts.push(prompt)
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), `export const v = ${prompts.length}\n`)
        execSync('git add -A && git commit --allow-empty -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
        return workerJson(order)
      },
      evaluateWriteGate: async (_input: EvaluateWorkerWriteGateInput) => {
        evaluations += 1
        return evaluations === 1 ? report('failed') : report('passed')
      },
    }))
    assert.equal(prompts.length, 2, 'exactly one repair round after the initial run')
    assert.ok(prompts[1]!.includes('ONE bounded repair round'), 'repair prompt carries the contract')
    assert.ok(prompts[1]!.includes('TS0000'), 'repair prompt carries gate evidence')
    assert.equal(run.result.status, 'passed', 'repair fixed it — result stands')
    assert.equal(run.writeGate?.repairCount, 1)
    assert.equal(run.writeGate?.report.outcome, 'passed')
  })

  it('gate failed twice → failed back to the primary, no second repair, no model switch', async () => {
    const order = testOrder({ id: 'wo-gate-fail2' })
    let agentRuns = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        agentRuns += 1
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), `export const v = ${agentRuns}\n`)
        execSync('git add -A && git commit --allow-empty -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
        return workerJson(order)
      },
      evaluateWriteGate: async () => report('failed', { falseGreen: true }),
    }))
    assert.equal(agentRuns, 2, 'initial run + exactly one bounded repair — never a third')
    assert.equal(run.result.status, 'failed')
    assert.equal(run.result.evidenceStatus, 'failed')
    assert.ok(run.result.risks.some(r => r.includes('falseGreen')), 'falseGreen recorded for primary adjudication')
    assert.equal(run.writeGate?.repairCount, 1)
  })

  it('gate blocked → environment-neutral: NO repair round, result blocked for primary', async () => {
    const order = testOrder({ id: 'wo-gate-blocked' })
    let agentRuns = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        agentRuns += 1
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), 'export const hello = 1\n')
        execSync('git add -A && git commit -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
        return workerJson(order)
      },
      evaluateWriteGate: async () => report('blocked', { evidence: ['❓ tsc — timed out'] }),
    }))
    assert.equal(agentRuns, 1, 'blocked is environment-neutral — no repair burn')
    assert.equal(run.result.status, 'blocked')
    assert.ok(run.result.risks.some(r => r.includes('environment-neutral')))
  })

  it('read-only result (no changedFiles) never invokes the gate', async () => {
    const order = testOrder({ id: 'wo-gate-readonly' })
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async () => workerJson(order, { changedFiles: [], evidenceStatus: 'skipped' }),
      evaluateWriteGate: async () => { throw new Error('gate must not run for read-only results') },
    }))
    assert.equal(run.result.status, 'passed')
    assert.equal(run.writeGate, undefined)
  })

  it('kill switch writeGateEnabled=false skips the gate entirely', async () => {
    const order = testOrder({ id: 'wo-gate-off' })
    const run = await runHandsSession(baseConfig(order, {
      writeGateEnabled: false,
      evaluateWriteGate: async () => { throw new Error('gate disabled — must not run') },
    }))
    assert.equal(run.result.status, 'passed')
    assert.equal(run.writeGate, undefined)
  })

  it('diff artifact includes bounded-repair changes (collected after the gate)', async () => {
    const order = testOrder({ id: 'wo-gate-diff' })
    let agentRuns = 0
    let evaluations = 0
    const run = await runHandsSession(baseConfig(order, {
      runAgent: async (_prompt, _callbacks, workerCwd) => {
        agentRuns += 1
        mkdirSync(join(workerCwd, 'src'), { recursive: true })
        writeFileSync(join(workerCwd, 'src', 'output.ts'), agentRuns === 1
          ? 'export const broken = 1\n'
          : 'export const repaired = 2\n')
        execSync('git add -A && git commit -m "worker output"', { cwd: workerCwd, stdio: 'pipe' })
        return workerJson(order)
      },
      evaluateWriteGate: async () => {
        evaluations += 1
        return evaluations === 1 ? report('failed') : report('passed')
      },
    }))
    const diffArtifact = run.result.artifacts.find(a => a.kind === 'diff')
    assert.ok(diffArtifact, 'diff artifact present')
    assert.ok(diffArtifact!.content.includes('repaired'), 'diff reflects the post-repair tree')
  })
})
