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

export interface SquadronResult {
  findings: ReviewFinding[]
}

export interface ReviewRouterDeps {
  spawnVerifier: (change: ChangeSet) => Promise<VerifierResult>
  spawnPatcher: (change: ChangeSet, verifier: VerifierResult) => Promise<PatcherResult>
  spawnSquadron: (change: ChangeSet) => Promise<SquadronResult>
}

export interface ReviewRouterOptions {
  maxRounds?: number
}

export interface ReviewOutcome {
  tier: ReviewScale
  verdict: ReviewVerdict | 'nudge'
  evidence?: string
  escalated?: boolean
  rounds?: number
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

/**
 * Route a change set through the review workflow selected by its scale.
 *
 * L1: nudge only, no child agents.
 * L2: single adversarial verifier, then bounded patch→verify loop on rejection.
 * L3: Review Squadron first, then the same bounded verifier loop.
 */
export async function routeReviewWorkflow(
  change: ChangeSet,
  deps: ReviewRouterDeps,
  options: ReviewRouterOptions = {},
): Promise<ReviewOutcome> {
  const tier = classifyChangeScale(change)
  if (tier === 'L1') return { tier, verdict: 'nudge' }

  if (tier === 'L3') {
    const squadron = await deps.spawnSquadron(change)
    if (hasBlockingSquadronFinding(squadron)) {
      return {
        tier,
        verdict: 'rejected',
        evidence: summarizeSquadronFindings(squadron),
        escalated: true,
        rounds: 0,
      }
    }
  }

  const maxRounds = Math.max(1, options.maxRounds ?? 1)
  let last: VerifierResult = { verdict: 'rejected', evidence: '' }

  for (let round = 1; round <= maxRounds; round++) {
    last = normalizeVerifierResult(await deps.spawnVerifier(change))
    if (last.verdict === 'verified') {
      return { tier, verdict: 'verified', evidence: last.evidence, rounds: round }
    }
    const patcher = await deps.spawnPatcher(change, last)
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
