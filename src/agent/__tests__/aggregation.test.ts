import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { aggregateResults } from '../aggregation.js'
import type { WorkerResult } from '../work-order.js'
import type { WorkerTranscript } from '../worker-session.js'

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

  // ── Spec A 改造一 P1: 验证缺失 nudge ─────────────────────────

  const NUDGE = '存在未验证的改动，应 delegate 一个对抗 verifier；你不能靠在汇总里列 caveat 自封通过。'

  function transcript(toolUses: string[]): WorkerTranscript {
    return {
      text: '',
      thinking: '',
      toolUses,
      toolResults: [],
      errors: [],
      repairAttempts: 0,
    }
  }

  function patcherResult(id: string, changedFiles: string[]): WorkerResult {
    return {
      workOrderId: id,
      status: 'passed',
      summary: 'applied patch',
      findings: [{ claim: 'changed files', evidence: 'diff', confidence: 'high' }],
      artifacts: [],
      changedFiles,
      risks: [],
      nextActions: [],
      evidenceStatus: changedFiles.length > 0 ? 'unverified' : 'verified',
    }
  }

  it('injects verification nudge when patcher changes files without adversarial_verifier', () => {
    const results = [patcherResult('wo_1', ['src/a.ts'])]
    const profiles = new Map([['wo_1', 'patcher']])
    const aggregated = aggregateResults(results, 'primary_decides', profiles)

    // Patcher without verification → should get advisory risk
    // Then nudge injected because no adversarial_verifier present
    assert.ok(aggregated[0]!.risks.some(r => r.includes('advisory')))
    assert.ok(aggregated[0]!.risks.some(r => r === NUDGE))
    // Nudge is soft — status unchanged
    assert.equal(aggregated[0]!.status, 'passed')
  })

  it('no nudge when adversarial_verifier is present alongside patcher changes', () => {
    const results = [
      patcherResult('wo_1', ['src/a.ts']),
      {
        workOrderId: 'wo_2',
        status: 'passed' as const,
        summary: 'verified the patch',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified' as const,
      },
    ]
    const profiles = new Map([['wo_1', 'patcher'], ['wo_2', 'adversarial_verifier']])
    // Post-"enforce adversarial verifier evidence": a verifier only counts as
    // genuinely verified when its transcript proves it ran run_tests. Supply that
    // transcript so wo_2 stays verified and the gap nudge is correctly suppressed.
    const transcripts = new Map([['wo_2', transcript(['run_tests'])]])
    const aggregated = aggregateResults(results, 'primary_decides', profiles, transcripts)

    assert.ok(aggregated[0]!.risks.some(r => r.includes('advisory')))
    // No nudge because adversarial_verifier is present
    assert.ok(!aggregated.some(r => r.risks.some(rr => rr === NUDGE)))
  })

  it('keeps nudge when adversarial_verifier did not actually run tests', () => {
    const results = [
      patcherResult('wo_1', ['src/a.ts']),
      {
        workOrderId: 'wo_2',
        status: 'passed' as const,
        summary: 'claimed verification after reading only',
        findings: [],
        artifacts: [],
        changedFiles: [],
        risks: [],
        nextActions: [],
        evidenceStatus: 'verified' as const,
      },
    ]
    const profiles = new Map([['wo_1', 'patcher'], ['wo_2', 'adversarial_verifier']])
    const transcripts = new Map([['wo_2', transcript(['read_file'])]])
    const aggregated = aggregateResults(results, 'primary_decides', profiles, transcripts)

    assert.ok(aggregated.some(r => r.risks.some(rr => rr === NUDGE)))
    const verifier = aggregated.find(r => r.workOrderId === 'wo_2')!
    assert.equal(verifier.evidenceStatus, 'unverified')
  })

  it('no nudge when no files were changed', () => {
    const results = [patcherResult('wo_1', [])]
    const profiles = new Map([['wo_1', 'patcher']])
    const aggregated = aggregateResults(results, 'primary_decides', profiles)

    // No changedFiles → passes through clean
    assert.equal(aggregated[0]!.status, 'passed')
    assert.ok(!aggregated.some(r => r.risks.some(rr => rr === NUDGE)))
  })

  it('no nudge when only adversarial_verifier runs (no write changes)', () => {
    const results = [{
      workOrderId: 'wo_1',
      status: 'passed' as const,
      summary: 'all tests pass',
      findings: [],
      artifacts: [],
      changedFiles: [],
      risks: [],
      nextActions: [],
      evidenceStatus: 'verified' as const,
    }]
    const profiles = new Map([['wo_1', 'adversarial_verifier']])
    const aggregated = aggregateResults(results, 'primary_decides', profiles)

    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.status, 'passed')
    assert.ok(!aggregated.some(r => r.risks.some(rr => rr === NUDGE)))
  })

  it('nudge injected with weighted_confidence policy when verification gap exists', () => {
    const results = [
      { ...patcherResult('wo_1', ['src/a.ts']), findings: [{ claim: 'ok', evidence: 'diff', confidence: 'high' as const }] },
      { ...patcherResult('wo_2', ['src/b.ts']), findings: [{ claim: 'ok', evidence: 'diff', confidence: 'low' as const }] },
    ]
    const profiles = new Map([['wo_1', 'patcher'], ['wo_2', 'patcher']])
    const aggregated = aggregateResults(results, 'weighted_confidence', profiles)

    // weighted_confidence picks highest confidence result
    assert.equal(aggregated.length, 1)
    assert.equal(aggregated[0]!.workOrderId, 'wo_1')
    // Nudge still injected
    assert.ok(aggregated[0]!.risks.some(r => r === NUDGE))
  })
})
