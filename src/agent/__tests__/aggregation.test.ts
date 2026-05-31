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
    // Blocked result should preserve the 'blocked' context in its risk message
    const blockedFailed = aggregated.find(r => r.workOrderId === 'b')
    assert.ok(blockedFailed!.risks.some(r => r.includes('blocked') && r.includes('unparseable or connectivity')))
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

  it('first_success: falls back to blocked result with findings when all blocked', () => {
    const results = [
      result('a', 'blocked'),
      { ...result('b', 'blocked'), findings: [{ claim: 'found X', evidence: 'grep', confidence: 'high' as const }] },
    ]
    const aggregated = aggregateResults(results, 'first_success')
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'b')
    assert.equal(aggregated[0]!.status, 'blocked')
    assert.ok(aggregated[0]!.risks.some(r => r.includes('best-effort')))
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

  it('majority: when majority is blocked, includes passed results as degraded signal', () => {
    const results = [
      result('a', 'blocked'),
      result('b', 'blocked'),
      result('c', 'passed'),
    ]
    const aggregated = aggregateResults(results, 'majority')
    // Should include both blocked (majority) and passed (degraded signal)
    assert.ok(aggregated.some(r => r.status === 'blocked'))
    assert.ok(aggregated.some(r => r.status === 'passed'))
    // Blocked results should have a caveat about passed results being available
    const blocked = aggregated.find(r => r.status === 'blocked')
    assert.ok(blocked!.risks.some(r => r.includes('passed results available')))
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

  it('weighted_confidence: selects result with highest average confidence', () => {
    const results = [
      result('a', 'passed', 'low'),
      result('b', 'passed', 'high'),
      result('c', 'passed', 'medium'),
    ]
    const aggregated = aggregateResults(results, 'weighted_confidence')
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'b')
  })

  it('weighted_confidence: returns all when no passed results', () => {
    const results = [result('a', 'failed', 'high'), result('b', 'blocked', 'low')]
    const aggregated = aggregateResults(results, 'weighted_confidence')
    assert.equal(aggregated.length, 2)
  })

  it('weighted_confidence: prefers result with findings over no findings', () => {
    const results = [
      result('a', 'passed'),
      result('b', 'passed', 'medium'),
    ]
    const aggregated = aggregateResults(results, 'weighted_confidence')
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'b')
  })
})
