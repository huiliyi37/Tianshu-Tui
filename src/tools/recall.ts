import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind } from '../context/claims.js'
import type { ToolDefinition } from '../api/types.js'
import { loadAllProjectMemoryEntries } from '../context/project-memory-loader.js'
import { stat, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'

interface RecallInput {
  query: string
  kind?: ContextClaimKind
  limit?: number
}

export interface RecallContext {
  sessionId: string
  getTurn: () => number
}

const DEFINITION: ToolDefinition = {
  name: 'recall',
  description: 'Search historical claims in context memory by keyword. Returns matching claims with their status, kind, and evidence.',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword (substring match on claim text)' },
      kind: { type: 'string', enum: ['user_constraint', 'user_preference', 'decision', 'file_observation', 'verification_fact', 'failure_pattern', 'security_finding', 'worker_finding', 'project_rule'], description: 'Filter by claim kind' },
      limit: { type: 'number', default: 5, description: 'Max results to return' },
    },
    required: ['query'],
  },
}

export async function searchKnowledgeFiles(cwd: string, query: string): Promise<string[]> {
  const dir = join(cwd, '.rivet', 'knowledge')
  try {
    await stat(dir)
  } catch {
    return []
  }

  const results: string[] = []
  const lowerQuery = query.toLowerCase()

  try {
    const files = (await readdir(dir)).filter(f => f.endsWith('.md'))
    for (const file of files) {
      const content = await readFile(join(dir, file), 'utf-8')
      const entries = content.split(/(?=^### )/m)
      for (const entry of entries) {
        if (entry.toLowerCase().includes(lowerQuery)) {
          results.push(entry.trim())
        }
      }
    }
  } catch {}

  return results.slice(0, 10)
}

export function createRecallTool(store: ContextClaimStore, ctx?: RecallContext & { cwd?: string }): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallInput
      const limit = input.limit ?? 5
      const filter = input.kind ? { kind: [input.kind] } : {}

      const matches = store.listClaims(filter)
        .filter(c => c.text.toLowerCase().includes(input.query.toLowerCase()))
        .sort((a, b) => b.fitness - a.fitness || b.confidence - a.confidence)
        .slice(0, limit)

      if (ctx) {
        const turn = ctx.getTurn()
        const usedAt = Date.now()
        for (const c of matches) {
          store.recordClaimUsed(c.id, { consumerId: `recall:turn-${turn}`, consumerKind: 'tool', usedAt })
          store.boostFitness(c.id, 1, 10)
        }
      }

      const parts: string[] = []

      if (matches.length > 0) {
        const formatted = matches.map(c =>
          `[claim:${c.id.slice(0, 8)}] (${c.kind}, ${c.status}, confidence=${c.confidence.toFixed(2)})\n  ${c.text.slice(0, 200)}`
        ).join('\n')
        parts.push(`Claims (${matches.length}):\n${formatted}`)
      }

      // Structured project memory search (.rivet/knowledge/memory.jsonl)
      const knowledgeCwd = ctx?.cwd ?? params.cwd
      if (knowledgeCwd) {
        const memoryHits = loadAllProjectMemoryEntries(knowledgeCwd)
          .filter(e => (!input.kind || e.kind === input.kind) && e.text.toLowerCase().includes(input.query.toLowerCase()))
          .slice(0, limit)

        if (memoryHits.length > 0) {
          const memoryFormatted = memoryHits.map(e =>
            `[memory:${e.id.slice(0, 8)}] (${e.kind}, confidence=${e.confidence.toFixed(2)})\n  ${e.text.slice(0, 200)}`,
          ).join('\n')
          parts.push(`Project memory (${memoryHits.length}):\n${memoryFormatted}`)
        }

        const knowledgeHits = await searchKnowledgeFiles(knowledgeCwd, input.query)
        if (knowledgeHits.length > 0) {
          const knowledgeFormatted = knowledgeHits.slice(0, 3).map(e => e.slice(0, 300)).join('\n---\n')
          parts.push(`\nProject knowledge (${knowledgeHits.length} entries):\n${knowledgeFormatted}`)
        }
      }

      if (parts.length === 0) {
        return { content: 'No claims or knowledge found matching query.' }
      }

      return { content: parts.join('\n') }
    },
    requiresApproval(): boolean { return false },
    isConcurrencySafe(): boolean { return true },
    isEnabled(): boolean { return true },
  }
}
