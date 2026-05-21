import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateResults } from '../aggregation.js'
import type { WorkerResult } from '../work-order.js'

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

  it('should block a worker with changedFiles but no verification when profile is not read-only', () => {
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
    assert.equal(results[0]!.status, 'blocked', 'Write worker with changedFiles but no verification should be blocked')
  })

  it('should handle missing profile gracefully (backward compatible)', () => {
    const result = makeResult()
    const results = aggregateResults([result], 'primary_decides')

    assert.equal(results.length, 1)
    assert.equal(results[0]!.status, 'passed')
  })
})
