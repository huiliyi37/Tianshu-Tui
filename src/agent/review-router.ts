import { classifyChangeScale, type ChangeSet, type ReviewScale } from './review-discipline.js'

export type ReviewVerdict = 'verified' | 'rejected'

export interface VerifierResult {
  verdict: ReviewVerdict
  /** Required command + observed output evidence. Blank evidence makes verified fail closed. */
  evidence: string
}

export interface PatcherResult {
  patched: boolean
}

export type ReviewFindingSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export interface ReviewFinding {
  severity?: ReviewFindingSeverity | Lowercase<ReviewFindingSeverity> | string
  claim?: string
}

export type ReviewInfraFailureKind = 'worker' | 'json' | 'timeout' | 'skip'

export interface ReviewInfraFailure {
  kind: ReviewInfraFailureKind | string
  claim: string
}

export interface SquadronResult {
  /** Real code/design findings produced by review workers. CRITICAL/HIGH blocks. */
  findings: ReviewFinding[]
  /** Review infrastructure failures: worker crash, non-JSON output, timeout, skipped review. */
  infraFailures?: ReviewInfraFailure[]
}

export interface ReviewRouterDeps {
  spawnVerifier: (change: ChangeSet, signal?: AbortSignal) => Promise<VerifierResult>
  spawnPatcher: (change: ChangeSet, verifier: VerifierResult, signal?: AbortSignal) => Promise<PatcherResult>
  spawnSquadron: (change: ChangeSet, signal?: AbortSignal) => Promise<SquadronResult>
}

export interface ReviewRouterOptions {
  maxRounds?: number
  /** AbortSignal to propagate to spawned verifier/patcher/squadron workers.
   *  When aborted, coordinator.delegate() will cancel in-flight worker sessions. */
  abortSignal?: AbortSignal
}

export interface ReviewOutcome {
  tier: ReviewScale
  verdict: ReviewVerdict | 'nudge'
  evidence?: string
  escalated?: boolean
  rounds?: number
  /** Non-code review infrastructure caveats from L3 squadron workers. */
  infraFailures?: ReviewInfraFailure[]
}

function hasEvidence(result: VerifierResult): boolean {
  return result.evidence.trim().length > 0
}

function normalizeVerifierResult(result: VerifierResult): VerifierResult {
  if (result.verdict === 'verified' && !hasEvidence(result)) {
    return { verdict: 'rejected', evidence: 'verified verdict missing command + observed output evidence' }
  }
  return result
}

function hasBlockingSquadronFinding(result: SquadronResult): boolean {
  return result.findings.some(finding => {
    const severity = finding.severity?.toUpperCase()
    return severity === 'CRITICAL' || severity === 'HIGH'
  })
}

function summarizeSquadronFindings(result: SquadronResult): string {
  const blocking = result.findings.filter(finding => {
    const severity = finding.severity?.toUpperCase()
    return severity === 'CRITICAL' || severity === 'HIGH'
  })
  const summary = blocking
    .map(finding => `${finding.severity ?? 'UNKNOWN'}: ${finding.claim ?? 'review finding'}`)
    .join('; ')
  return summary.length > 0 ? `squadron blocking findings: ${summary}` : 'squadron blocking findings'
}

function summarizeInfraFailures(failures: ReviewInfraFailure[]): string {
  return failures
    .map(failure => `${failure.kind}: ${failure.claim}`)
    .join('; ')
}

/**
 * Route a change set through the review workflow selected by its scale.
 *
 * L1: nudge only, no child agents.
 * L2: single adversarial verifier, then bounded patch→verify loop on rejection.
 * L3: Review Squadron (4 inspectors). Squadron pass → verified (skip L2 loop).
 *     Squadron finds blocking issues → rejected.
 */
export async function routeReviewWorkflow(
  change: ChangeSet,
  deps: ReviewRouterDeps,
  options: ReviewRouterOptions = {},
): Promise<ReviewOutcome> {
  const tier = classifyChangeScale(change)
  if (tier === 'L1') return { tier, verdict: 'nudge' }

  const signal = options.abortSignal

  let infraFailures: ReviewInfraFailure[] = []
  if (tier === 'L3') {
    const squadron = await deps.spawnSquadron(change, signal)
    infraFailures = squadron.infraFailures ?? []
    if (hasBlockingSquadronFinding(squadron)) {
      return {
        tier,
        verdict: 'rejected',
        evidence: summarizeSquadronFindings(squadron),
        escalated: true,
        rounds: 0,
        ...(infraFailures.length > 0 ? { infraFailures } : {}),
      }
    }
    // Squadron passed without blocking findings — skip L2 verifier loop.
    // The 4-inspector squadron already covers Security/Lifecycle/DataFlow/Silence.
    return {
      tier,
      verdict: 'verified',
      evidence: `L3 squadron verified (4 inspectors): no blocking findings`,
      rounds: 0,
      ...(infraFailures.length > 0 ? { infraFailures } : {}),
    }
  }

  const maxRounds = Math.max(1, options.maxRounds ?? 1)
  let last: VerifierResult = { verdict: 'rejected', evidence: '' }

  for (let round = 1; round <= maxRounds; round++) {
    last = normalizeVerifierResult(await deps.spawnVerifier(change, signal))
    if (last.verdict === 'verified') {
      const infraEvidence = infraFailures.length > 0
        ? `${last.evidence}\nReview infra caveats: ${summarizeInfraFailures(infraFailures)}`
        : last.evidence
      return {
        tier,
        verdict: 'verified',
        evidence: infraEvidence,
        rounds: round,
        ...(infraFailures.length > 0 ? { infraFailures } : {}),
      }
    }
    const patcher = await deps.spawnPatcher(change, last, signal)
    if (!patcher.patched) {
      return {
        tier,
        verdict: 'rejected',
        evidence: last.evidence,
        escalated: true,
        rounds: round,
      }
    }
  }

  return {
    tier,
    verdict: 'rejected',
    evidence: last.evidence,
    escalated: true,
    rounds: maxRounds,
  }
}
