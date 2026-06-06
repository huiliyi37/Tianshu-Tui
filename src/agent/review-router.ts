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

export interface SquadronResult {
  findings: unknown[]
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
    await deps.spawnSquadron(change)
  }

  const maxRounds = Math.max(1, options.maxRounds ?? 3)
  let last: VerifierResult = { verdict: 'rejected', evidence: '' }

  for (let round = 1; round <= maxRounds; round++) {
    last = normalizeVerifierResult(await deps.spawnVerifier(change))
    if (last.verdict === 'verified') {
      return { tier, verdict: 'verified', evidence: last.evidence, rounds: round }
    }
    await deps.spawnPatcher(change, last)
  }

  return {
    tier,
    verdict: 'rejected',
    evidence: last.evidence,
    escalated: true,
    rounds: maxRounds,
  }
}
