import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateResults } from '../aggregation.js'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'

function makeResult(overrides: Partial<WorkerResult> = {}): WorkerResult {
  return {
    workOrderId: 'wo-1',
    status: 'passed',
    summary: 'Found 3 files',
    findings: [{ claim: 'File A exists', evidence: 'read_file output', confidence: 'high' }],
    artifacts: [],
    changedFiles: [],
    examinedFiles: ['src/a.ts'],
    risks: [],
    nextActions: [],
    evidenceStatus: 'skipped',
    ...overrides,
  }
}

function makeTranscript(toolUses: string[]): WorkerTranscript {
  return {
    text: '',
    thinking: '',
    toolUses,
    toolResults: [],
    errors: [],
    repairAttempts: 0,
  }
}

describe('aggregateResults with profile propagation', () => {
  it('should pass read-only profile to verifyWorkerEvidence to skip gate when changedFiles is empty', () => {
    // A code_scout worker with no changedFiles but missing verification.
    // Without profile propagation, verifyWorkerEvidence is called without profile,
    // and the gate still skips because changedFiles.length === 0.
    // But the test ensures the profile is actually passed through.
    const readOnlyResult: WorkerResult = {
      workOrderId: 'wo-scout',
      status: 'passed',
      summary: 'Analyzed code structure',
      findings: [{ claim: 'Found 5 modules', evidence: 'repo_map output', confidence: 'high' }],
      artifacts: [],
      changedFiles: [],
      examinedFiles: ['src/a.ts', 'src/b.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'skipped',
    }

    const profiles = new Map([['wo-scout', 'code_scout']])
    const results = aggregateResults([readOnlyResult], 'primary_decides', profiles)

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed', 'Read-only worker with empty changedFiles should remain passed')
  })

  it('should keep patcher advisory instead of blocked when profile is propagated', () => {
    const writeResult: WorkerResult = {
      workOrderId: 'wo-patcher',
      status: 'passed',
      summary: 'Applied patch',
      findings: [],
      artifacts: [],
      changedFiles: ['src/c.ts'],
      examinedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'skipped',
    }

    const profiles = new Map([['wo-patcher', 'patcher']])
    const results = aggregateResults([writeResult], 'primary_decides', profiles)

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed', 'Patcher with changedFiles but no verification should remain passed with advisory risk')
    assert.ok(results[0]!.risks.some(r => r.includes('advisory')))
  })

  it('should handle missing profile gracefully (backward compatible)', () => {
    const result = makeResult()
    const results = aggregateResults([result], 'primary_decides')

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed')
  })

  it('downgrades adversarial_verifier verified verdict when transcript lacks run_tests', () => {
    const verifierResult = makeResult({
      workOrderId: 'wo-verifier',
      summary: 'Looks verified but only read files',
      evidenceStatus: 'verified',
      examinedFiles: ['src/a.ts'],
    })
    const profiles = new Map([['wo-verifier', 'adversarial_verifier']])
    const transcripts = new Map([['wo-verifier', makeTranscript(['read_file', 'grep'])]])

    const results = aggregateResults([verifierResult], 'primary_decides', profiles, transcripts)

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed')
    assert.equal(results[0]!.evidenceStatus, 'unverified')
    assert.ok(results[0]!.risks.some(r => r.includes('without running run_tests')))
  })

  it('accepts adversarial_verifier verified verdict when transcript includes run_tests', () => {
    const verifierResult = makeResult({
      workOrderId: 'wo-verifier',
      summary: 'Verified with tests',
      evidenceStatus: 'verified',
    })
    const profiles = new Map([['wo-verifier', 'adversarial_verifier']])
    const transcripts = new Map([['wo-verifier', makeTranscript(['read_file', 'run_tests'])]])

    const results = aggregateResults([verifierResult], 'primary_decides', profiles, transcripts)

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed')
    assert.equal(results[0]!.evidenceStatus, 'verified')
    assert.equal(results[0]!.risks.length, 0)
  })
})
