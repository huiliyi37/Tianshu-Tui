import { createHash } from 'node:crypto'
import type { ContextAnchor } from './types.js'

export type ContextClaimKind =
  | 'user_constraint'
  | 'user_preference'
  | 'decision'
  | 'file_observation'
  | 'verification_fact'
  | 'failure_pattern'
  | 'security_finding'
  | 'worker_finding'
  | 'project_rule'

export type ContextClaimScope = 'turn' | 'session' | 'project' | 'repo' | 'global'

export type ContextClaimStatus =
  | 'ephemeral'
  | 'active'
  | 'durable_candidate'
  | 'durable'
  | 'stale'
  | 'conflicted'
  | 'quarantined'

export type EvidenceKind = 'user_message' | 'assistant_message' | 'tool_result' | 'file' | 'test' | 'worker' | 'hook' | 'compact' | 'resume'
export type ContextActor = 'user' | 'assistant' | 'tool' | 'worker' | 'hook' | 'compact' | 'resume'

export interface EvidenceRef {
  id: string
  kind: EvidenceKind
  summary: string
  path?: string
  createdAt: number
}

export interface ConsumerRef {
  id: string
  kind: 'prompt' | 'tool' | 'test' | 'worker'
  usedAt: number
}

export interface ClaimSource {
  actor: ContextActor
  sessionId: string
  turn: number
  eventId: string
}

export interface ContextClaim {
  id: string
  kind: ContextClaimKind
  scope: ContextClaimScope
  status: ContextClaimStatus
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  consumers: ConsumerRef[]
  counterevidence: EvidenceRef[]
  createdAt: number
  lastUsedAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposal {
  kind: ContextClaimKind
  scope: ContextClaimScope
  text: string
  confidence: number
  fitness: number
  source: ClaimSource
  evidence: EvidenceRef[]
  createdAt: number
  expiresAt?: number
  tags: string[]
}

export interface ClaimProposalMeta extends ClaimSource {
  createdAt: number
}

function normalizeClaimText(text: string): string {
  return text.trim().replace(/\s+/g, ' ').toLowerCase()
}

function claimIdFor(proposal: ClaimProposal): string {
  return createHash('sha256')
    .update(JSON.stringify({
      kind: proposal.kind,
      scope: proposal.scope,
      text: normalizeClaimText(proposal.text),
      sessionId: proposal.source.sessionId,
    }))
    .digest('hex')
    .slice(0, 12)
}

function escapeXml(text: string): string {
  return text
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

function kindFromAnchor(anchor: ContextAnchor): ContextClaimKind {
  if (anchor.kind === 'user_constraint') return 'user_constraint'
  if (anchor.kind === 'user_preference') return 'user_preference'
  if (anchor.kind === 'decision') return 'decision'
  if (anchor.kind === 'verification') return 'verification_fact'
  if (anchor.kind === 'error') return 'failure_pattern'
  return 'file_observation'
}

function confidenceFromAnchor(anchor: ContextAnchor): number {
  if (anchor.kind === 'user_constraint') return 0.9
  if (anchor.kind === 'decision') return 0.82
  if (anchor.kind === 'verification') return 0.88
  return 0.7
}

export function claimProposalFromAnchor(anchor: ContextAnchor, meta: ClaimProposalMeta): ClaimProposal {
  return {
    kind: kindFromAnchor(anchor),
    scope: 'session',
    text: anchor.text,
    confidence: confidenceFromAnchor(anchor),
    fitness: anchor.salience,
    source: {
      actor: meta.actor,
      sessionId: meta.sessionId,
      turn: meta.turn,
      eventId: meta.eventId,
    },
    evidence: [{
      id: `${meta.eventId}:anchor`,
      kind: meta.actor === 'user' ? 'user_message' : 'assistant_message',
      summary: anchor.text,
      createdAt: meta.createdAt,
    }],
    createdAt: meta.createdAt,
    tags: ['anchor', anchor.kind],
  }
}

export function createClaimFromProposal(proposal: ClaimProposal): ContextClaim {
  return {
    id: claimIdFor(proposal),
    kind: proposal.kind,
    scope: proposal.scope,
    status: 'active',
    text: proposal.text,
    confidence: proposal.confidence,
    fitness: proposal.fitness,
    source: proposal.source,
    evidence: [...proposal.evidence],
    consumers: [],
    counterevidence: [],
    createdAt: proposal.createdAt,
    lastUsedAt: proposal.createdAt,
    expiresAt: proposal.expiresAt,
    tags: [...proposal.tags],
  }
}

export function isPromptEligibleClaim(claim: ContextClaim): boolean {
  return claim.status === 'active' || claim.status === 'durable_candidate' || claim.status === 'durable'
}

export function renderActiveClaimsBlock(claims: ContextClaim[]): string {
  const active = claims
    .filter(isPromptEligibleClaim)
    .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence || a.createdAt - b.createdAt)

  if (active.length === 0) return ''

  const entries = active.map(claim => {
    const evidence = claim.evidence[0]?.id ?? ''
    return `  <claim id="${escapeXml(claim.id)}" kind="${claim.kind}" scope="${claim.scope}" confidence="${claim.confidence.toFixed(2)}" evidence="${escapeXml(evidence)}">${escapeXml(claim.text)}</claim>`
  })

  return `<active-claims count="${active.length}">\n${entries.join('\n')}\n</active-claims>`
}
