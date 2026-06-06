import test from 'node:test'
import assert from 'node:assert/strict'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'
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

function transcript(toolUses: string[], errors: string[] = []): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses,
    toolResults: [],
    errors,
    repairAttempts: 0,
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
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts'])
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

test('passes through read-only worker with examinedFiles and empty changedFiles', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/auth.ts', 'src/login.ts'],
    evidenceStatus: 'unverified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.deepEqual(checked.examinedFiles, ['src/auth.ts', 'src/login.ts'])
})

test('passes through read-only worker with examinedFiles even when evidenceStatus is verified', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    examinedFiles: ['src/config.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
})

test('patcher profile gets advisory risk instead of blocked', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'patcher')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('advisory')))
})

test('verifier profile (old verifier) now blocked instead of advisory', () => {
  // Old verifier is no longer in WRITE_PROFILES_ADVISORY — treated as regular write worker
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    evidenceStatus: 'unverified',
  }), 'verifier')

  assert.equal(checked.status, 'blocked')
  assert.equal(checked.evidenceStatus, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('unverified')))
})

test('adversarial_verifier verified verdict requires run_tests in transcript', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier verified verdict without transcript is fail-closed', () => {
  // No transcript provided = cannot prove tests were run = downgrade
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('without running run_tests')))
})

test('adversarial_verifier keeps verified verdict when run_tests was actually used', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'verified')
  assert.equal(checked.risks.length, 0)
})

test('adversarial_verifier with unchanged evidenceStatus still passes through', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'unverified',
  }), 'adversarial_verifier')

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
})

test('adversarial_verifier downgrades verified when run_tests errored', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: [],
    evidenceStatus: 'verified',
  }), 'adversarial_verifier', transcript(['read_file', 'run_tests'], ['run_tests: Test run failed']))

  assert.equal(checked.status, 'passed')
  assert.equal(checked.evidenceStatus, 'unverified')
  assert.ok(checked.risks.some(r => r.includes('errored')))
})

test('blocks write worker with changedFiles and examinedFiles but no verification', () => {
  const checked = verifyWorkerEvidence(result({
    changedFiles: ['src/a.ts'],
    examinedFiles: ['src/b.ts'],
    evidenceStatus: 'verified',
  }))

  assert.equal(checked.status, 'blocked')
  assert.ok(checked.risks.some(r => r.includes('missing verification metadata')))
})
