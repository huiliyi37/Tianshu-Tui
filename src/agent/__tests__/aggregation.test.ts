import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateResults } from '../aggregation.js'
import type { WorkerResult } from '../work-order.js'

function result(id: string, status: WorkerResult['status'], confidence?: 'low' | 'medium' | 'high'): WorkerResult {
  return {
    workOrderId: id,
    status,
    summary: `${status} result for ${id}`,
    findings: confidence ? [{ claim: 'test', evidence: 'evidence', confidence }] : [],
    artifacts: [],
    changedFiles: [],
    risks: [],
    nextActions: [],
    evidenceStatus: status === 'passed' ? 'verified' : 'unverified',
  }
}

describe('aggregateResults', () => {
  it('primary_decides: returns all results as-is', () => {
    const results = [result('a', 'passed'), result('b', 'failed')]
    const aggregated = aggregateResults(results, 'primary_decides')
    assert.deepEqual(aggregated, results)
  })

  it('all_required: fails if any result is not passed', () => {
    const results = [result('a', 'passed'), result('b', 'blocked')]
    const aggregated = aggregateResults(results, 'all_required')
    assert.equal(aggregated.length, 2)
    assert.ok(aggregated.some(r => r.status === 'failed'))
  })

  it('all_required: passes when all pass', () => {
    const results = [result('a', 'passed'), result('b', 'passed')]
    const aggregated = aggregateResults(results, 'all_required')
    assert.ok(aggregated.every(r => r.status === 'passed'))
  })

  it('first_success: returns only the first passed result', () => {
    const results = [result('a', 'failed'), result('b', 'passed'), result('c', 'passed')]
    const aggregated = aggregateResults(results, 'first_success')
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'b')
  })

  it('first_success: returns all failed if nothing passed', () => {
    const results = [result('a', 'failed'), result('b', 'blocked')]
    const aggregated = aggregateResults(results, 'first_success')
    assert.equal(aggregated.length, 2)
  })

  it('majority: returns the majority status', () => {
    const results = [
      result('a', 'passed'),
      result('b', 'passed'),
      result('c', 'failed'),
    ]
    const aggregated = aggregateResults(results, 'majority')
    assert.ok(aggregated.every(r => r.status === 'passed'))
  })

  it('majority: returns all when tied', () => {
    const results = [result('a', 'passed'), result('b', 'failed')]
    const aggregated = aggregateResults(results, 'majority')
    assert.equal(aggregated.length, 2)
  })

  it('blocks implementation result that changed files without verified evidence', () => {
    const results: WorkerResult[] = [{
      workOrderId: 'wo1',
      status: 'passed',
      summary: 'Changed files',
      findings: [],
      artifacts: [],
      changedFiles: ['src/agent/loop.ts'],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
    }]
    const aggregated = aggregateResults(results, 'primary_decides')
    assert.equal(aggregated[0]!.status, 'blocked')
    assert.ok(aggregated[0]!.risks.some(r => r.includes('unverified')))
  })

  it('does not block read-only results with unverified evidence', () => {
    const results: WorkerResult[] = [{
      workOrderId: 'wo1',
      status: 'passed',
      summary: 'Found the seam.',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'unverified',
    }]
    const aggregated = aggregateResults(results, 'primary_decides')
    assert.equal(aggregated[0]!.status, 'passed')
  })
})
