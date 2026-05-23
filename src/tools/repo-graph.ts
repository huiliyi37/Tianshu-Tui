import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

interface RepoGraphInput {
  from_file: string
  max_tokens?: number
}

const DEFINITION: ToolDefinition = {
  name: 'repo_graph',
  description: `Query the code graph to find files and symbols structurally related to a given file. Returns a ranked list of related files with their exported symbols, ordered by call/import proximity. Use this to discover relevant code before reading files.

### When to use
- After reading a file, to find what it depends on or what depends on it
- Before editing, to understand the blast radius of a change
- To navigate unfamiliar code by following structural connections

### How it works
The graph is built incrementally as you read/edit files. More files read = richer graph.`,
  input_schema: {
    type: 'object',
    properties: {
      from_file: { type: 'string', description: 'File path to find related code for (relative to project root)' },
      max_tokens: { type: 'number', default: 2000, description: 'Token budget for the response (controls how many files are returned)' },
    },
    required: ['from_file'],
  },
}

export function createRepoGraphTool(getIndexer: () => MeridianIndexer | null): Tool {
  return {
    definition: DEFINITION,
    async execute(params: ToolCallParams): Promise<ToolResult> {
      const indexer = getIndexer()
      if (!indexer) {
        return { content: 'Meridian graph not initialized. Read some files first to build the index.', isError: true }
      }

      const input = params.input as unknown as RepoGraphInput
      const result = await indexer.query(input.from_file, { maxTokens: input.max_tokens ?? 2000 })

      if (result.entries.length === 0) {
        return { content: `No graph data for \`${input.from_file}\`. Read the file first to index it.` }
      }

      const lines: string[] = [
        `## Code Graph from \`${input.from_file}\``,
        `Index: ${result.graphSize} files, ${result.totalSymbols} symbols`,
        '',
      ]

      for (const entry of result.entries) {
        lines.push(`### ${entry.filePath} (score: ${entry.score.toFixed(2)})`)
        for (const sym of entry.symbols) {
          const prefix = sym.kind === 'function' ? 'ƒ' : sym.kind === 'class' ? '◆' : sym.kind === 'interface' || sym.kind === 'type' ? '◇' : '•'
          lines.push(`  ${prefix} ${sym.name} L${sym.line}`)
        }
        lines.push('')
      }

      const content = lines.join('\n')
      return { content: content.length > 15000 ? content.slice(0, 15000) + '\n...(truncated)' : content }
    },
    requiresApproval() { return false },
    isConcurrencySafe() { return true },
    isEnabled() { return true },
  }
}
