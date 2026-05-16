import type { AggregationPolicy, WorkerResult } from './work-order.js'

export function aggregateResults(results: WorkerResult[], policy: AggregationPolicy): WorkerResult[] {
  // Evidence gate: block implementation results that changed files without verified evidence
  const gated = results.map(r => {
    if (r.changedFiles.length > 0 && r.evidenceStatus !== 'verified') {
      return {
        ...r,
        status: 'blocked' as const,
        risks: [...r.risks, `unverified: ${r.changedFiles.length} file(s) changed without verified evidence`],
      }
    }
    return r
  })

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

  return gated
}
