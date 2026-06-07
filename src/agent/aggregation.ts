import type { AggregationPolicy, WorkerResult } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'
import { verifyWorkerEvidence } from './worker-evidence.js'
import { profileRegistry } from './profile-registry.js'

const CONFIDENCE_WEIGHTS: Record<string, number> = { high: 3, medium: 2, low: 1 }

function confidenceScore(result: WorkerResult): number {
  if (result.findings.length === 0) return 0
  const total = result.findings.reduce((sum, f) => sum + (CONFIDENCE_WEIGHTS[f.confidence] ?? 1), 0)
  return total / result.findings.length
}

/** Profiles whose role is 'hands' — they can write files. */
function isWriteProfile(profile: string): boolean {
  const def = profileRegistry.get(profile)
  return def?.role === 'hands'
}

/**
 * Detect verification gap: if any write-capable worker changed files but no
 * adversarial_verifier is present in the batch, return a nudge risk string.
 */
function detectVerificationGap(results: WorkerResult[], profiles?: Map<string, string>): string | null {
  let hasWriteChanges = false
  let hasAdversarialVerifier = false

  for (const r of results) {
    const profile = profiles?.get(r.workOrderId)
    if (profile === 'adversarial_verifier') {
      if (r.status === 'passed' && r.evidenceStatus === 'verified') {
        hasAdversarialVerifier = true
      }
      continue
    }
    if (profile && isWriteProfile(profile) && r.changedFiles.length > 0) {
      hasWriteChanges = true
    }
  }

  if (hasWriteChanges && !hasAdversarialVerifier) {
    return '存在未验证的改动，应 delegate 一个对抗 verifier；你不能靠在汇总里列 caveat 自封通过。'
  }
  return null
}

/**
 * Inject a verification gap nudge into results with changedFiles.
 * Does not change status — it's a soft nudge, not a hard block.
 */
function injectVerificationNudge(results: WorkerResult[], nudge: string): WorkerResult[] {
  return results.map(r => {
    if (r.changedFiles.length > 0 && !r.risks.includes(nudge)) {
      return { ...r, risks: [...r.risks, nudge] }
    }
    return r
  })
}

function applyPolicy(results: WorkerResult[], policy: AggregationPolicy): WorkerResult[] {
  if (policy === 'primary_decides') return results

  if (policy === 'all_required') {
    const hasFailure = results.some(r => r.status !== 'passed')
    if (!hasFailure) return results
    return results.map(r => {
      if (r.status === 'passed') return r
      const reason = r.status === 'blocked'
        ? `all_required: work order ${r.workOrderId} was blocked (unparseable or connectivity issue)`
        : `all_required: work order ${r.workOrderId} did not pass`
      return { ...r, status: 'failed' as const, risks: [...r.risks, reason] }
    })
  }

  if (policy === 'first_success') {
    const firstPass = results.find(r => r.status === 'passed')
    if (firstPass) return [firstPass]
    const withFindings = results.filter(r => r.findings.length > 0)
    if (withFindings.length > 0) {
      const best = withFindings.reduce((a, b) => a.findings.length >= b.findings.length ? a : b)
      return [{ ...best, status: 'blocked' as const, risks: [...best.risks, 'first_success: no worker passed; returning best-effort blocked result with findings'] }]
    }
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
      if (majorityStatus === 'blocked') {
        const passed = results.filter(r => r.status === 'passed')
        if (passed.length > 0) {
          return results.filter(r => r.status === 'blocked' || r.status === 'passed')
            .map(r => r.status === 'passed' ? r : {
              ...r,
              risks: [...r.risks, 'majority: blocked workers present but passed results available as signal'],
            })
        }
      }
      return results.filter(r => r.status === majorityStatus)
    }
    return results
  }

  if (policy === 'weighted_confidence') {
    const passed = results.filter(r => r.status === 'passed')
    if (passed.length === 0) return results
    const best = passed.reduce((a, b) => confidenceScore(a) >= confidenceScore(b) ? a : b)
    return [best]
  }

  return results
}

export function aggregateResults(
  results: WorkerResult[],
  policy: AggregationPolicy,
  profiles?: Map<string, string>,
  transcripts?: Map<string, WorkerTranscript>,
): WorkerResult[] {
  // Step 1: gate each result through evidence verification
  const gated = results.map(r => verifyWorkerEvidence(r, profiles?.get(r.workOrderId), transcripts?.get(r.workOrderId)))

  // Step 2: detect verification gap across the batch
  const nudge = detectVerificationGap(gated, profiles)

  // Step 3: apply aggregation policy
  const aggregated = applyPolicy(gated, policy)

  // Step 4: inject soft nudge if verification gap detected
  if (nudge) {
    return injectVerificationNudge(aggregated, nudge)
  }

  return aggregated
}
