import type { ContextClaim } from './claims.js'

export const MAX_ACTIVE_CLAIMS = 50

const EXEMPT_KINDS: ContextClaim['kind'][] = ['project_rule', 'user_constraint', 'user_preference']

export function selectEvictionCandidates(activeClaims: ContextClaim[]): ContextClaim[] {
  const evictable = activeClaims.filter(c => !EXEMPT_KINDS.includes(c.kind))
  if (evictable.length <= MAX_ACTIVE_CLAIMS) return []

  const sorted = [...evictable].sort((a, b) =>
    a.fitness - b.fitness || a.confidence - b.confidence || a.lastUsedAt - b.lastUsedAt,
  )

  return sorted.slice(0, evictable.length - MAX_ACTIVE_CLAIMS)
}
