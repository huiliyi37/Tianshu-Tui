import type { WorkerResult } from './work-order.js'
import type { WorkerTranscript } from './worker-session.js'

function addRisk(risks: string[], risk: string): string[] {
  return risks.includes(risk) ? risks : [...risks, risk]
}

const WRITE_PROFILES_ADVISORY = ['patcher']

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
 * @param transcript - Optional worker transcript for behavior-backed verifier gating
 */
export function verifyWorkerEvidence(result: WorkerResult, profile?: string, transcript?: WorkerTranscript): WorkerResult {
  if (profile === 'adversarial_verifier' && result.evidenceStatus === 'verified') {
    // Fail-closed: no transcript = cannot prove tests were run = unverified
    if (!transcript) {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'adversarial_verifier reported verified without running run_tests'),
      }
    }
    const runTestsIdx = transcript.toolUses.lastIndexOf('run_tests')
    if (runTestsIdx === -1) {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'adversarial_verifier reported verified without running run_tests'),
      }
    }
    // Defense in depth: check that run_tests didn't error out. We match on the
    // recorded error strings rather than index-correlating toolResults[i] with
    // toolUses[i] — coupled to the error message format, but robust to reorder.
    const testsErrored = transcript.errors.some(e =>
      e.includes('run_tests') || e.includes('Test run failed'),
    )
    if (testsErrored) {
      return {
        ...result,
        evidenceStatus: 'unverified',
        risks: addRisk(result.risks, 'adversarial_verifier ran run_tests but it errored — verdict not trustworthy'),
      }
    }
  }

  // All workers with no changed files pass through — the evidence gate
  // is only about write workers who mutate files.
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
