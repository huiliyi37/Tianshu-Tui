import type { WorkerResult } from './work-order.js'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

const READ_ONLY_PROFILES = ['code_scout', 'doc_scout', 'planner', 'reviewer']
const WRITE_PROFILES_ADVISORY = ['patcher', 'verifier']

/**
 * Verify worker evidence for mutation safety.
 *
 * Gate logic: only `changedFiles` (files actually mutated) triggers verification.
 * `examinedFiles` (files read/inspected) are informational and never trigger the gate.
 *
 * When a `profile` is provided and it's a read-only profile, the gate is skipped
 * entirely if `changedFiles` is empty — read-only workers don't need verification metadata.
 *
 * This distinction is critical for read-only workers (code_scout, reviewer, etc.)
 * that examine files without modifying them — they should use `examinedFiles` and
 * leave `changedFiles` empty to pass through without verification metadata.
 *
 * @param result - The worker result to verify
 * @param profile - Optional worker profile for profile-aware verification
 */
export function verifyWorkerEvidence(result: WorkerResult, profile?: string): WorkerResult {
  // Read-only profiles skip the verification gate when no files were changed.
  // Without a profile, the same mutation-based rule still applies: examinedFiles are informational only.
  if (result.changedFiles.length === 0) return result

  if (profile && WRITE_PROFILES_ADVISORY.includes(profile)) {
    if (result.evidenceStatus !== 'verified') {
      return {
        ...result,
        risks: addRisk(result.risks, `advisory: ${result.changedFiles.length} file(s) changed without verified evidence`),
      }
    }
    return result
  }

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
