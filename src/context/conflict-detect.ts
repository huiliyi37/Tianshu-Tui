import type { ContextClaim } from './claims.js'

export interface ClaimConflict {
  olderClaimId: string
  newerClaimId: string
  sharedPath: string
}

const CONFLICTABLE_KINDS: ContextClaim['kind'][] = ['file_observation', 'verification_fact']
const ACTIVE_STATUSES: ContextClaim['status'][] = ['active', 'durable_candidate', 'durable']

function normalizeText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

export function detectConflicts(claims: ContextClaim[]): ClaimConflict[] {
  const eligible = claims.filter(c => CONFLICTABLE_KINDS.includes(c.kind) && ACTIVE_STATUSES.includes(c.status))
  const byPath = new Map<string, ContextClaim[]>()

  for (const c of eligible) {
    for (const ev of c.evidence) {
      if (!ev.path) continue
      const group = byPath.get(ev.path) ?? []
      group.push(c)
      byPath.set(ev.path, group)
    }
  }

  const conflicts: ClaimConflict[] = []
  for (const [path, group] of byPath) {
    if (group.length < 2) continue
    const sorted = group.sort((a, b) => a.createdAt - b.createdAt)
    for (let i = 0; i < sorted.length - 1; i++) {
      // Skip if text is semantically identical (same normalized content)
      if (normalizeText(sorted[i]!.text) === normalizeText(sorted[i + 1]!.text)) continue
      conflicts.push({
        olderClaimId: sorted[i]!.id,
        newerClaimId: sorted[i + 1]!.id,
        sharedPath: path,
      })
    }
  }
  return conflicts
}
