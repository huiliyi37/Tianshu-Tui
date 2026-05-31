import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind, ContextClaimScope } from '../context/claims.js'
import { appendProjectMemory, compactProjectMemory } from '../context/project-memory-writer.js'

interface RememberInput {
  kind: ContextClaimKind
  text: string
  scope?: ContextClaimScope
  confidence?: number
  tags?: string[]
}

export interface RememberContext {
  sessionId: string
  getTurn: () => number
  cwd?: string
}

const KINDS: ContextClaimKind[] = [
  'decision',
  'file_observation',
  'verification_fact',
  'failure_pattern',
  'project_rule',
]

export function createRememberTool(store: ContextClaimStore, ctx?: RememberContext): Tool {
  return {
    definition: {
      name: 'remember',
      description: `Persist a claim to context memory. Use this to store decisions, observations,
verification facts, failure patterns, or project rules that should survive
compaction and be recallable later via the recall tool.

Claim kinds:
- decision — architectural or implementation decisions made
- file_observation — key observations about specific files
- verification_fact — test results or verified facts
- failure_pattern — bugs encountered and their root causes
- project_rule — patterns or conventions discovered in the codebase

Claims stored with scope='project' survive across sessions.`,
      input_schema: {
        type: 'object',
        properties: {
          kind: { type: 'string', enum: KINDS, description: 'Kind of claim to store' },
          text: { type: 'string', description: 'The claim text — be concise and specific (1-3 sentences)' },
          scope: { type: 'string', enum: ['session', 'project'], default: 'session', description: 'Lifetime: session (dies with session) or project (survives across sessions)' },
          confidence: { type: 'number', default: 0.9, description: 'Confidence 0-1. Use 0.9+ for verified facts, 0.5-0.7 for tentative observations' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
        },
        required: ['kind', 'text'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RememberInput
      const turn = ctx?.getTurn() ?? 0
      const eventId = `remember:${Date.now()}`

      const claim = store.propose({
        kind: input.kind,
        scope: input.scope ?? 'session',
        text: input.text.trim(),
        confidence: input.confidence ?? 0.9,
        fitness: 3,
        source: {
          actor: 'assistant',
          sessionId: ctx?.sessionId ?? 'unknown',
          turn,
          eventId,
        },
        evidence: [{
          id: eventId,
          kind: 'assistant_message',
          summary: `Model-initiated claim: ${input.text.slice(0, 100)}`,
          createdAt: Date.now(),
        }],
        createdAt: Date.now(),
        tags: input.tags ?? [],
      })

      // Auto-write project-scoped claims to .rivet/knowledge/memory.jsonl
      if ((input.scope ?? 'session') === 'project' && ctx?.cwd) {
        appendProjectMemory(ctx.cwd, claim)
        compactProjectMemory(ctx.cwd)
      }

      return {
        content: `Claim stored [${claim.id.slice(0, 8)}] (${claim.kind}, ${claim.scope}, c=${claim.confidence.toFixed(2)})\n  ${claim.text.slice(0, 200)}`,
      }
    },

    requiresApproval(): boolean {
      return false
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}
