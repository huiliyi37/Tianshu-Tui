import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { PersistentStore } from '../context/persistent-store.js'
import type { ToolDefinition } from '../api/types.js'

interface RecallInput {
  query: string
  type?: 'tool_result' | 'all'
  toolName?: string
  since?: string
  limit?: number
}

const DEFINITION: ToolDefinition = {
  name: 'recall',
  description: 'Retrieve archived tool results from persistent memory',
  input_schema: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search keyword or file path' },
      type: { type: 'string', enum: ['tool_result', 'all'], default: 'all' },
      toolName: { type: 'string', description: 'Filter by tool name' },
      since: { type: 'string', description: 'ISO 8601 timestamp filter' },
      limit: { type: 'number', default: 5 },
    },
    required: ['query'],
  },
}

export function createRecallTool(store: PersistentStore): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const input = params.input as unknown as RecallInput
      const results = store.search({
        query: input.query || undefined,
        toolName: input.toolName,
        since: input.since,
        limit: input.limit ?? 5,
      })
      if (results.length === 0) {
        return { content: 'No archived results found matching query.' }
      }
      const formatted = results.map(r =>
        `[${r.toolName}] round ${r.roundNumber} (${r.timestamp}):\n${r.content.slice(0, 2000)}`
      ).join('\n---\n')
      return { content: formatted }
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
