import type { WorkerResult } from './work-order.js'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

const READ_ONLY_PROFILES = ['code_scout', 'doc_scout', 'planner', 'reviewer']

/**
 * Verify worker evidence for mutation safety.
 *
 * Gate logic: only `changedFiles` (files actually mutated) triggers verification.
 * `examinedFiles` (files read/inspected) are informational and never trigger the gate.
 *
 * When a `profile` is provided and it's a read-only profile, the gate is skipped
 * entirely if `changedFiles` is empty — read-only workers don't need verification metadata.
 *
 * @param result - The worker result to verify
 * @param profile - Optional worker profile for profile-aware verification
 */
export function verifyWorkerEvidence(result: WorkerResult, profile?: string): WorkerResult {
  // Read-only profiles skip the verification gate when no files were changed
  if (profile && READ_ONLY_PROFILES.includes(profile) && result.changedFiles.length === 0) {
    return result
  }

  // Only gate on changedFiles (mutations). examinedFiles are informational.
  if (result.changedFiles.length === 0) return result

  const unverifiedRisk = `unverified: ${result.changedFiles.length} file(s) changed without verified evidence`

  if (result.evidenceStatus !== 'verified') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, unverifiedRisk),
    }
  }

  if (!result.verification) {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, 'verified worker result is missing verification metadata'),
    }
  }

  if (result.verification.status === 'failed') {
    return {
      ...result,
      status: 'failed',
      evidenceStatus: 'failed',
      risks: addRisk(result.risks, `worker verification failed: ${result.verification.command}`),
    }
  }

  if (result.verification.status === 'blocked') {
    return {
      ...result,
      status: 'blocked',
      evidenceStatus: 'blocked',
      risks: addRisk(result.risks, `worker verification blocked: ${result.verification.command}`),
    }
  }

  return result
}
