import type { AggregationPolicy, WorkerResult } from './work-order.js'
import { verifyWorkerEvidence } from './worker-evidence.js'

const CONFIDENCE_WEIGHTS: Record<string, number> = { high: 3, medium: 2, low: 1 }

function confidenceScore(result: WorkerResult): number {
  if (result.findings.length === 0) return 0
  const total = result.findings.reduce((sum, f) => sum + (CONFIDENCE_WEIGHTS[f.confidence] ?? 1), 0)
  return total / result.findings.length
}

export function aggregateResults(results: WorkerResult[], policy: AggregationPolicy, profiles?: Map<string, string>): WorkerResult[] {
  const gated = results.map(r => verifyWorkerEvidence(r, profiles?.get(r.workOrderId)))

  if (policy === 'primary_decides') return gated

  if (policy === 'all_required') {
    const hasFailure = gated.some(r => r.status !== 'passed')
    if (!hasFailure) return gated
    return gated.map(r => {
      if (r.status === 'passed') return r
      // Distinguish 'blocked' (parse/connectivity error) from genuine 'failed' (wrong answer)
      // Blocked results get a softer downgrade with the original reason preserved
      const reason = r.status === 'blocked'
        ? `all_required: work order ${r.workOrderId} was blocked (unparseable or connectivity issue)`
        : `all_required: work order ${r.workOrderId} did not pass`
      return { ...r, status: 'failed' as const, risks: [...r.risks, reason] }
    })
  }

  if (policy === 'first_success') {
    const firstPass = gated.find(r => r.status === 'passed')
    if (firstPass) return [firstPass]
    // Fallback: if all blocked, try to return the one with most findings as a degraded signal
    const withFindings = gated.filter(r => r.findings.length > 0)
    if (withFindings.length > 0) {
      const best = withFindings.reduce((a, b) => a.findings.length >= b.findings.length ? a : b)
      return [{ ...best, status: 'blocked' as const, risks: [...best.risks, 'first_success: no worker passed; returning best-effort blocked result with findings'] }]
    }
    return gated
  }

  if (policy === 'majority') {
    const counts = new Map<WorkerResult['status'], number>()
    for (const r of gated) {
      counts.set(r.status, (counts.get(r.status) ?? 0) + 1)
    }
    let maxCount = 0
    let majorityStatus: WorkerResult['status'] = 'passed'
    for (const [status, count] of counts) {
      if (count > maxCount) {
        maxCount = count
        majorityStatus = status
      }
    }
    if (maxCount > gated.length / 2) {
      // When majority is 'blocked', upgrade to include any passed results as degraded signals
      if (majorityStatus === 'blocked') {
        const passed = gated.filter(r => r.status === 'passed')
        if (passed.length > 0) {
          return gated.filter(r => r.status === 'blocked' || r.status === 'passed')
            .map(r => r.status === 'passed' ? r : {
              ...r,
              risks: [...r.risks, 'majority: blocked workers present but passed results available as signal'],
            })
        }
      }
      return gated.filter(r => r.status === majorityStatus)
    }
    return gated
  }

  if (policy === 'weighted_confidence') {
    const passed = gated.filter(r => r.status === 'passed')
    if (passed.length === 0) return gated
    const best = passed.reduce((a, b) => confidenceScore(a) >= confidenceScore(b) ? a : b)
    return [best]
  }

  return gated
}
