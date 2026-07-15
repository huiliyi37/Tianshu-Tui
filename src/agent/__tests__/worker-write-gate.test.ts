import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  applyWriteGateToResult,
  buildWorkerVerifyRepairPrompt,
  evaluateWorkerWriteGate,
  isDeclaredVerificationFalseGreen,
} from '../worker-write-gate.js'
import { createWriteWorkOrder, type WorkerResult } from '../work-order.js'
import type { WaveGateCheck } from '../wave-gate.js'

function baseResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-1',
    status: 'passed',
    summary: 'did the thing',
    findings: [],
    artifacts: [],
    changedFiles: ['src/a.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

function stubEvaluate(checks: WaveGateCheck[]) {
  return async () => ({ passed: checks.every(c => c.status === 'passed'), checks })
}

describe('worker-write-gate (W4-D1)', () => {
  it('read-only result (no changedFiles) skips the code gate', async () => {
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result: baseResult({ changedFiles: [] }),
      evaluate: async () => { throw new Error('gate must not run for read-only results') },
    })
    assert.equal(report.outcome, 'skipped')
  })

  it('all checks passed → passed, no falseGreen', async () => {
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result: baseResult(),
      evaluate: stubEvaluate([{ command: 'tsc --noEmit (scoped)', status: 'passed' }]),
    })
    assert.equal(report.outcome, 'passed')
    assert.equal(report.falseGreen, false)
  })

  it('failed check → failed; worker claimed passed → falseGreen', async () => {
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result: baseResult({
        verification: {
          command: 'npm test', status: 'passed', scope: 'targeted',
          exitCode: 0, passed: 3, failed: 0, skipped: 0, durationMs: 100,
        },
      }),
      evaluate: stubEvaluate([{ command: 'tsc --noEmit (scoped)', status: 'failed', detail: 'TS2345 in src/a.ts' }]),
    })
    assert.equal(report.outcome, 'failed')
    assert.equal(report.falseGreen, true, 'worker claimed passed but the main gate failed')
    assert.ok(report.evidence.some(l => l.includes('TS2345')))
  })

  it('blocking unverifiable only → blocked (environment-neutral)', async () => {
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result: baseResult(),
      evaluate: stubEvaluate([{ command: 'tsc --noEmit (scoped)', status: 'unverifiable', blocking: true, detail: 'tsc timed out' }]),
    })
    assert.equal(report.outcome, 'blocked')
    assert.equal(report.falseGreen, false, 'blocked is never a capability signal')
  })

  it('failed dominates blocked when both present', async () => {
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result: baseResult(),
      evaluate: stubEvaluate([
        { command: 'tsc --noEmit (scoped)', status: 'unverifiable', blocking: true },
        { command: 'npm test', status: 'failed', detail: '1 failing' },
      ]),
    })
    assert.equal(report.outcome, 'failed')
  })

  it('declared exit 0 + 0 passed is false-green and cannot pass the gate', async () => {
    const result = baseResult({
      verification: {
        command: 'npm test -- --grep nothing', status: 'passed', scope: 'targeted',
        exitCode: 0, passed: 0, failed: 0, skipped: 0, durationMs: 50,
      },
    })
    assert.equal(isDeclaredVerificationFalseGreen(result), true)
    const report = await evaluateWorkerWriteGate({
      cwd: '/tmp',
      result,
      evaluate: stubEvaluate([{ command: 'tsc --noEmit (scoped)', status: 'passed' }]),
    })
    assert.equal(report.outcome, 'failed', 'exit 0 with 0 tests executed proves nothing')
    assert.equal(report.declaredFalseGreen, true)
  })

  it('applyWriteGateToResult folds failed/blocked into result immutably', () => {
    const original = baseResult()
    const failedReport = {
      outcome: 'failed' as const, checks: [], evidence: ['❌ tsc — TS2345'],
      falseGreen: true, declaredFalseGreen: false,
    }
    const failed = applyWriteGateToResult(original, failedReport, 1)
    assert.equal(failed.status, 'failed')
    assert.equal(failed.evidenceStatus, 'failed')
    assert.ok(failed.risks.some(r => r.includes('1 bounded repair round')))
    assert.ok(failed.risks.some(r => r.includes('falseGreen')))
    assert.equal(original.status, 'passed', 'input result must not be mutated')

    const blockedReport = {
      outcome: 'blocked' as const, checks: [], evidence: ['❓ tsc — timed out'],
      falseGreen: false, declaredFalseGreen: false,
    }
    const blocked = applyWriteGateToResult(original, blockedReport, 0)
    assert.equal(blocked.status, 'blocked')
    assert.ok(blocked.risks.some(r => r.includes('environment-neutral')))

    const passedReport = {
      outcome: 'passed' as const, checks: [], evidence: [],
      falseGreen: false, declaredFalseGreen: false,
    }
    assert.equal(applyWriteGateToResult(original, passedReport, 0), original, 'passed leaves the result untouched')
  })

  it('repair prompt carries the gate evidence and the one-round contract', () => {
    const order = createWriteWorkOrder({
      parentTurnId: 't1',
      kind: 'patch_proposal',
      objective: 'fix the parser',
      scope: { files: ['src/a.ts'] },
    })
    const prompt = buildWorkerVerifyRepairPrompt(order, {
      outcome: 'failed', checks: [], evidence: ['❌ tsc — TS2345 in src/a.ts'],
      falseGreen: false, declaredFalseGreen: false,
    })
    assert.ok(prompt.includes('TS2345'))
    assert.ok(prompt.includes('ONE bounded repair round'))
    assert.ok(prompt.includes(order.id))
  })
})
