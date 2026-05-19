import type { AggregationPolicy, WorkerResult } from './work-order.js'
import { verifyWorkerEvidence } from './worker-evidence.js'

const CONFIDENCE_WEIGHTS: Record<string, number> = { high: 3, medium: 2, low: 1 }

function confidenceScore(result: WorkerResult): number {
  if (result.findings.length === 0) return 0
  const total = result.findings.reduce((sum, f) => sum + (CONFIDENCE_WEIGHTS[f.confidence] ?? 1), 0)
  return total / result.findings.length
}

export function aggregateResults(results: WorkerResult[], policy: AggregationPolicy): WorkerResult[] {
  const gated = results.map(verifyWorkerEvidence)

  if (policy === 'primary_decides') return gated

  if (policy === 'all_required') {
    const hasFailure = gated.some(r => r.status !== 'passed')
    if (!hasFailure) return gated
    return gated.map(r =>
      r.status === 'passed' ? r : { ...r, status: 'failed', risks: [...r.risks, `all_required: work order ${r.workOrderId} did not pass`] },
    )
  }

  if (policy === 'first_success') {
    const firstPass = gated.find(r => r.status === 'passed')
    if (firstPass) return [firstPass]
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
