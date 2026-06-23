/**
 * memory tool — unified context memory: recall (search) + remember (persist).
 *
 * Merges the former recall + remember tools into a single tool with a
 * discriminated action field. Both operate on the same context claim store;
 * recall additionally searches .rivet/knowledge/ markdown files.
 */

import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ContextClaimStore } from '../context/claim-store.js'
import type { ContextClaimKind, ContextClaimScope } from '../context/claims.js'
import type { ToolDefinition } from '../api/types.js'
import { loadAllProjectMemoryEntries } from '../context/project-memory-loader.js'
import { recallMemoryEntries, type MemoryKind } from '../memory/unified-memory.js'
import { appendProjectMemory, compactProjectMemory } from '../context/project-memory-writer.js'
import { stat, readFile } from 'node:fs/promises'
import { join } from 'node:path'

// ── recall helpers ──

const DEFINITION: ToolDefinition = {
  name: 'memory',
  description: `Search and persist context memory claims across sessions.

### Actions
- recall: Search historical claims in context memory by keyword. Returns matching claims with their status, kind, and evidence.
- remember: Persist a claim to context memory (decisions, observations, verification facts, failure patterns, or project rules) that survives compaction and is recallable later.

### Claim kinds (for remember)
- decision — architectural or implementation decisions made
- file_observation — key observations about specific files
- verification_fact — test results or verified facts
- failure_pattern — bugs encountered and their root causes
- project_rule — patterns or conventions discovered in the codebase`,
  input_schema: {
    type: 'object',
    properties: {
      action: { type: 'string', enum: ['recall', 'remember'], description: 'recall: search memory; remember: store a claim' },
      // recall params
      query: { type: 'string', description: 'Search keyword (substring match on claim text). Required for recall.' },
      kind: { type: 'string', enum: ['user_constraint', 'user_preference', 'decision', 'file_observation', 'verification_fact', 'failure_pattern', 'security_finding', 'worker_finding', 'project_rule'], description: 'Filter by claim kind' },
      limit: { type: 'number', default: 5, description: 'Max results to return' },
      // remember params
      text: { type: 'string', description: 'The claim text — be concise and specific (1-3 sentences). Required for remember.' },
      scope: { type: 'string', enum: ['session', 'project'], default: 'session', description: 'Lifetime: session (dies with session) or project (survives across sessions)' },
      confidence: { type: 'number', default: 0.9, description: 'Confidence 0-1. Use 0.9+ for verified facts, 0.5-0.7 for tentative observations' },
      tags: { type: 'array', items: { type: 'string' }, description: 'Optional tags for categorization' },
    },
    required: ['action'],
  },
}

export async function searchKnowledgeFiles(cwd: string, query: string): Promise<string[]> {
  const dir = join(cwd, '.rivet', 'knowledge')
  try { await stat(dir) } catch { return [] }
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir)
  const lower = query.toLowerCase()
  const matches: string[] = []
  for (const entry of entries) {
    if (!entry.endsWith('.md')) continue
    try {
      const content = await readFile(join(dir, entry), 'utf-8')
      if (content.toLowerCase().includes(lower)) {
        matches.push(entry.replace(/\.md$/, ''))
      }
    } catch { /* skip unreadable */ }
  }
  return matches
}

export interface MemoryContext {
  sessionId: string
  getTurn: () => number
  cwd?: string
}

const REMEMBER_KINDS: ContextClaimKind[] = [
  'decision', 'file_observation', 'verification_fact',
  'failure_pattern', 'project_rule',
]

export function createMemoryTool(store: ContextClaimStore, ctx?: MemoryContext): Tool {
  return {
    definition: DEFINITION,

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action

      if (action === 'recall') {
        const query = typeof params.input.query === 'string' ? params.input.query.trim() : ''
        if (!query) return { content: 'Error: query is required for recall', isError: true }

        const kind = typeof params.input.kind === 'string' ? params.input.kind as MemoryKind : undefined
        const limit = typeof params.input.limit === 'number' ? params.input.limit : 5

        const entries = recallMemoryEntries(store, { query, kind, limit })

        // Also search .rivet/knowledge/ markdown files
        const cwd = ctx?.cwd ?? process.cwd()
        const knowledgeMatches = await searchKnowledgeFiles(cwd, query)

        // Load project-level memory
        const projectEntries = await loadAllProjectMemoryEntries(cwd)

        const lines: string[] = []
        if (entries.length > 0) {
          lines.push(`Cross-session memory (${entries.length}):`)
          for (const e of entries) lines.push(`- ${e.kind}: ${e.text}`)
        }
        if (projectEntries.length > 0) {
          lines.push(`Project memory (${projectEntries.length}):`)
          for (const e of projectEntries) lines.push(`- ${e.kind}: ${e.text}`)
        }
        if (knowledgeMatches.length > 0) {
          lines.push(`Knowledge files (${knowledgeMatches.length}):`)
          for (const m of knowledgeMatches) lines.push(`- ${m}`)
        }
        if (lines.length === 0) return { content: `No memory found for "${query}".` }
        return { content: lines.join('\n') }
      }

      // action === 'remember'
      const kind = typeof params.input.kind === 'string'
        ? (REMEMBER_KINDS.includes(params.input.kind as ContextClaimKind) ? params.input.kind as ContextClaimKind : null)
        : null
      if (!kind) {
        return { content: `Error: kind is required for remember. Must be one of: ${REMEMBER_KINDS.join(', ')}`, isError: true }
      }
      const text = typeof params.input.text === 'string' ? params.input.text.trim() : ''
      if (!text) return { content: 'Error: text is required for remember', isError: true }

      const scope: ContextClaimScope = params.input.scope === 'project' ? 'project' : 'session'
      const confidence = typeof params.input.confidence === 'number' ? Math.max(0, Math.min(1, params.input.confidence)) : 0.9
      const tags = Array.isArray(params.input.tags) ? params.input.tags.filter((t): t is string => typeof t === 'string') : undefined

      const turn = ctx?.getTurn() ?? 0
      const sessionId = ctx?.sessionId ?? 'unknown'

      store.add({
        kind,
        text,
        scope,
        confidence,
        tags,
        turn,
        sessionId,
      })

      // Also persist to project memory if scope is project
      if (scope === 'project' && ctx?.cwd) {
        appendProjectMemory(ctx.cwd, {
          kind,
          text,
          confidence,
          tags,
        })
        compactProjectMemory(ctx.cwd)
      }

      return { content: `✅ Remembered: [${kind}] ${text}` }
    },

    requiresApproval: () => false,
    isConcurrencySafe: () => true,
    isEnabled: () => true,
  }
}

// ── Backward-compat: createRecallTool / createRememberTool ──
export const createRecallTool = createMemoryTool
export const createRememberTool = createMemoryTool
