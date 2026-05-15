import type { AggregationPolicy, WorkerResult } from './work-order.js'

export function aggregateResults(results: WorkerResult[], policy: AggregationPolicy): WorkerResult[] {
  if (policy === 'primary_decides') return results

  if (policy === 'all_required') {
    const hasFailure = results.some(r => r.status !== 'passed')
    if (!hasFailure) return results
    return results.map(r =>
      r.status === 'passed' ? r : { ...r, status: 'failed', risks: [...r.risks, `all_required: work order ${r.workOrderId} did not pass`] },
    )
  }

  if (policy === 'first_success') {
    const firstPass = results.find(r => r.status === 'passed')
    if (firstPass) return [firstPass]
    return results
  }

  if (policy === 'majority') {
    const counts = new Map<WorkerResult['status'], number>()
    for (const r of results) {
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
    if (maxCount > results.length / 2) {
      return results.filter(r => r.status === majorityStatus)
    }
    return results
  }

  return results
}
