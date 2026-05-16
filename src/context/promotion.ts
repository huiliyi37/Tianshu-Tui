import { isPromptEligibleClaim, type ContextClaim, type ContextClaimStatus } from './claims.js'

export interface ClaimStatusCounts {
  active: number
  stale: number
  conflicted: number
  durable: number
  durableCandidate: number
  quarantined: number
}

export function evaluatePromotion(claim: ContextClaim, now = Date.now()): ContextClaimStatus | null {
  if (claim.status !== 'active') return null
  if (!isPromptEligibleClaim(claim, now)) return null
  if (claim.counterevidence.length > 0) return null
  if (claim.consumers.length < 3) return null
  return 'durable_candidate'
}

export function claimHasFileEvidence(claim: ContextClaim, path: string): boolean {
  if (claim.kind !== 'file_observation' && claim.kind !== 'verification_fact') return false
  return claim.evidence.some(evidence => evidence.path === path)
}

export function countClaimsByStatus(claims: ContextClaim[]): ClaimStatusCounts {
  return claims.reduce<ClaimStatusCounts>((counts, c) => {
    if (c.status === 'active') return { ...counts, active: counts.active + 1 }
    if (c.status === 'stale') return { ...counts, stale: counts.stale + 1 }
    if (c.status === 'conflicted') return { ...counts, conflicted: counts.conflicted + 1 }
    if (c.status === 'durable') return { ...counts, durable: counts.durable + 1 }
    if (c.status === 'durable_candidate') return { ...counts, durableCandidate: counts.durableCandidate + 1 }
    if (c.status === 'quarantined') return { ...counts, quarantined: counts.quarantined + 1 }
    return counts
  }, { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0 })
}
