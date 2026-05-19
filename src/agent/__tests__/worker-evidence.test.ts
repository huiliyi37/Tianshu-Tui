import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerResult } from '../work-order.js'
import { verifyWorkerEvidence } from '../worker-evidence.js'

function result(overrides: Partial<WorkerResult>): WorkerResult {
  return {
    workOrderId: 'wo_1',
    status: 'passed',
    summary: 'ok',
    findings: [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: 'unverified',
    ...overrides,
  }
}

test('blocks changed files without verified evidence', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('blocks self-reported verified result without verification metadata', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})

test('fails worker result when verification metadata failed', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'verified',
    verification: {
      command: 'npm test',
      status: 'failed',
      scope: 'targeted',
      exitCode: 1,
      passed: 1,
      failed: 1,
      skipped: 0,
      durationMs: 10,
    },
  }))

  assert.equal(checked.status, 'failed')
  assert.equal(checked.evidenceStatus, 'failed')
})

test('does not duplicate an existing risk', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
    risks: ['unverified: 1 file(s) changed without verified evidence'],
  }))

  assert.equal(checked.risks.filter(r => r.includes('unverified')).length, 1)
})

test('read-only profile skips verification gate when changedFiles is empty', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts'],
    evidenceStatus: 'unverified',
  }), 'code_scout')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('read-only profile skips verification gate for reviewer', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'unverified',
  }), 'reviewer')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('write profile does not skip verification gate', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'patcher')

  assert.equal(checked.status, 'blocked')
})

test('verifier profile does not skip verification gate', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'verifier')

  assert.equal(checked.status, 'blocked')
})
