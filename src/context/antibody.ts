import type { ClassifiedFailure } from '../agent/failure-classifier.js'
import type { ClaimProposal } from './claims.js'

export interface AntibodyContext {
  toolName: string
  command?: string
  sessionId: string
  turn: number
  eventId: string
}

const ANTIBODY_TTL = 4 * 60 * 60_000 // 4 hours

export function createAntibodyProposal(failure: ClassifiedFailure, ctx: AntibodyContext): ClaimProposal {
  const createdAt = Date.now()
  return {
    kind: 'failure_pattern',
    scope: 'session',
    text: `[${failure.class}] ${failure.suggestion}`,
    confidence: failure.confidence,
    fitness: failure.retryable ? 2 : 5,
    source: { actor: 'tool', sessionId: ctx.sessionId, turn: ctx.turn, eventId: ctx.eventId },
    evidence: [{
      id: `${ctx.eventId}:failure`,
      kind: 'tool_result',
      summary: `${ctx.toolName}: ${failure.class}${ctx.command ? ` (${ctx.command.slice(0, 80)})` : ''}`,
      createdAt,
    }],
    createdAt,
    expiresAt: createdAt + ANTIBODY_TTL,
    tags: ['antibody', failure.class],
  }
}
