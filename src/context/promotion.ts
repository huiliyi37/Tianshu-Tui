import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { isPromptEligibleClaim, type ContextClaim, type ContextClaimStatus } from './claims.js'

export interface ClaimStatusCounts {
  active: number
  stale: number
  conflicted: number
  durable: number
  durableCandidate: number
  quarantined: number
  /** Claims blocked by recall-gate (evidence files no longer exist). */
  recallBlocked: number
}

/**
 * Recall-gate — NREM consolidation filter.
 *
 * Before promoting a claim from active → durable_candidate → durable,
 * verify that its file evidence still exists on disk.
 *
 * This implements the recall-gated consolidation principle: only
 * consolidate information that can still be retrieved and verified.
 * If evidence files have been deleted or moved, the claim's basis
 * is irrecoverable — promotion is blocked.
 *
 * Skipped when cwd is not provided (e.g., in tests without filesystem).
 */
export function canRecallClaim(claim: ContextClaim, cwd?: string): boolean {
  if (!cwd) return true // no cwd → skip recall check (non-blocking)

  const filePaths = claim.evidence
    .filter(e => e.path !== undefined)
    .map(e => e.path!)

  if (filePaths.length === 0) return true // no file evidence → no recall check needed

  // At least one evidence file must still exist
  return filePaths.some(p => existsSync(join(cwd, p)))
}

export function evaluatePromotion(claim: ContextClaim, now = Date.now()): ContextClaimStatus | null {
  if (!isPromptEligibleClaim(claim, now)) return null
  if (claim.counterevidence.length > 0) return null

  if (claim.status === 'active') {
    if (new Set(claim.consumers.map(c => c.id)).size < 3) return null
    return 'durable_candidate'
  }

  if (claim.status === 'durable_candidate') {
    const age = now - claim.createdAt
    if (age < 10 * 60_000) return null
    if (new Set(claim.consumers.map(c => c.id)).size < 5) return null
    return 'durable'
  }

  return null
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
  }, { active: 0, stale: 0, conflicted: 0, durable: 0, durableCandidate: 0, quarantined: 0, recallBlocked: 0 })
}
