import type { ContextClaim } from '../context/claims.js'

/** Maximum number of claims to project into a worker's knowledge block. */
export const MAX_KNOWLEDGE_CLAIMS = 10

/**
 * Build an XML knowledge block for injection into a worker's prompt context.
 * Provides a read-only snapshot of the primary session's active claims,
 * filtered and sorted by fitness.
 *
 * Excludes worker_finding claims to prevent circular knowledge loops.
 */
export function buildWorkerKnowledgeBlock(claims: ContextClaim[]): string {
  const eligible = claims
    .filter(c => c.kind !== 'worker_finding')
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence)
    .slice(0, MAX_KNOWLEDGE_CLAIMS)

  if (eligible.length === 0) return ''

  const claimLines = eligible.map(c =>
    `  <claim id="${c.id}" kind="${c.kind}" confidence="${c.confidence.toFixed(2)}" fitness="${c.fitness}">${escapeXml(c.text)}</claim>`
  )

  return `<worker-knowledge>\n${claimLines.join('\n')}\n</worker-knowledge>`
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
}
