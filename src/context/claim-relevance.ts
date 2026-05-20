import { isPromptEligibleClaim, type ContextClaim } from './claims.js'

export interface ClaimRelevanceInput {
  query?: string
  workingSet?: string[]
  recentTools?: Array<{ tool: string; target: string; status: string }>
  now?: number
  maxClaims?: number
  minScore?: number
}

export interface ClaimRenderMeta {
  omitted: number
  totalEligible: number
}

export interface ScoredClaim {
  claim: ContextClaim
  score: number
  reasons: string[]
}

export interface ClaimRelevanceResult {
  selected: ContextClaim[]
  scored: ScoredClaim[]
  omitted: ScoredClaim[]
}

const DEFAULT_MAX_CLAIMS = 6
const DEFAULT_MIN_SCORE = 25
const RECENT_MS = 10 * 60 * 1000
const STALE_MS = 60 * 60 * 1000

const KIND_BASE_SCORE: Record<ContextClaim['kind'], number> = {
  user_constraint: 100,
  security_finding: 80,
  verification_fact: 70,
  failure_pattern: 50,
  decision: 45,
  user_preference: 40,
  project_rule: 40,
  worker_finding: 20,
  file_observation: 10,
}

function tokenize(value: string | undefined): string[] {
  if (!value) return []
  return [...new Set(value
    .toLowerCase()
    .split(/[^a-z0-9\u4e00-\u9fa5._/-]+/)
    .map(t => t.trim())
    .filter(t => t.length >= 2))]
}

function containsToken(haystack: string, tokens: string[]): boolean {
  if (tokens.length === 0) return false
  const lower = haystack.toLowerCase()
  return tokens.some(token => lower.includes(token))
}

function pathMatches(path: string | undefined, candidates: string[]): boolean {
  if (!path) return false
  return candidates.some(candidate => path === candidate || path.endsWith(candidate) || candidate.endsWith(path))
}

function isHardKeep(claim: ContextClaim): boolean {
  if (claim.kind === 'user_constraint') return true
  if (claim.kind === 'security_finding' && claim.confidence >= 0.7) return true
  if (claim.kind === 'verification_fact') {
    const text = claim.text.toLowerCase()
    return text.includes('fail') || text.includes('failed') || text.includes('blocked') || text.includes('失败')
  }
  return false
}

/**
 * Epigenetic imprinting: age itself is information.
 * A durable claim that has survived 30 sessions carries more weight than
 * a fresh claim with identical content — it has been validated by time.
 *
 * Weight: 1.0 baseline, +0.1 per 7 days of survival, capped at 2.0.
 * Only applies to durable and durable_candidate claims.
 */
const AGE_WEIGHT_PER_WEEK = 0.1
const AGE_WEIGHT_CAP = 2.0
const MS_PER_WEEK = 7 * 24 * 60 * 60 * 1000

function claimAgeWeight(claim: ContextClaim, now: number): number {
  if (claim.status !== 'durable' && claim.status !== 'durable_candidate') return 1.0
  const ageMs = now - claim.createdAt
  const weeks = ageMs / MS_PER_WEEK
  return Math.min(1.0 + weeks * AGE_WEIGHT_PER_WEEK, AGE_WEIGHT_CAP)
}

export function scoreClaimRelevance(claim: ContextClaim, input: ClaimRelevanceInput = {}): ScoredClaim | null {
  const now = input.now ?? Date.now()
  if (!isPromptEligibleClaim(claim, now)) return null

  let score = KIND_BASE_SCORE[claim.kind]
  const reasons = [`kind:${claim.kind}+${KIND_BASE_SCORE[claim.kind]}`]
  const queryTokens = tokenize(input.query)
  const workingSet = input.workingSet ?? []
  const recentTargets = (input.recentTools ?? []).map(t => t.target).filter(Boolean)

  if (containsToken(claim.tags.join(' '), queryTokens)) {
    score += 25
    reasons.push('tag-query-match+25')
  }

  if (containsToken(claim.text, queryTokens)) {
    score += 20
    reasons.push('text-query-match+20')
  }

  if (claim.evidence.some(e => pathMatches(e.path, workingSet))) {
    score += 30
    reasons.push('working-set-evidence+30')
  }

  if (recentTargets.some(target => claim.text.includes(target) || claim.evidence.some(e => e.summary.includes(target) || e.path?.includes(target)))) {
    score += 20
    reasons.push('recent-tool-target+20')
  }

  if (now - claim.lastUsedAt <= RECENT_MS) {
    score += 10
    reasons.push('recent-use+10')
  }

  const hasAnyMatch = reasons.some(r => r.includes('match') || r.includes('working-set') || r.includes('recent-tool'))
  if (now - claim.createdAt > STALE_MS && !hasAnyMatch) {
    score -= 30
    reasons.push('old-unmatched-30')
  }

  if (claim.kind === 'file_observation' && !hasAnyMatch) {
    score -= 25
    reasons.push('unmatched-file-observation-25')
  }

  if (claim.kind === 'worker_finding' && !hasAnyMatch) {
    score -= 20
    reasons.push('unmatched-worker-finding-20')
  }

  // Epigenetic imprinting: age weight for durable claims
  const ageWeight = claimAgeWeight(claim, now)
  if (ageWeight > 1.0) {
    score = Math.round(score * ageWeight)
    reasons.push(`age-weight×${ageWeight.toFixed(1)}`)
  }

  if (isHardKeep(claim)) {
    score += 1000
    reasons.push('hard-keep+1000')
  }

  return { claim, score, reasons }
}

export function selectRelevantClaims(claims: ContextClaim[], input: ClaimRelevanceInput = {}): ClaimRelevanceResult {
  const maxClaims = input.maxClaims ?? DEFAULT_MAX_CLAIMS
  const minScore = input.minScore ?? DEFAULT_MIN_SCORE
  const scored = claims
    .map(claim => scoreClaimRelevance(claim, input))
    .filter((claim): claim is ScoredClaim => claim !== null)
    .sort((a, b) => b.score - a.score || b.claim.confidence - a.claim.confidence || a.claim.createdAt - b.claim.createdAt)

  const selected: ScoredClaim[] = []
  const omitted: ScoredClaim[] = []

  for (const scoredClaim of scored) {
    const hardKeep = scoredClaim.reasons.some(r => r.startsWith('hard-keep'))
    const eligible = hardKeep || scoredClaim.score >= minScore
    if (eligible && (selected.length < maxClaims || hardKeep)) {
      selected.push(scoredClaim)
    } else {
      omitted.push(scoredClaim)
    }
  }

  return {
    selected: selected.map(s => s.claim),
    scored,
    omitted,
  }
}
