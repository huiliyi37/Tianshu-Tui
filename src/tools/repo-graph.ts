import type { Tool, ToolCallParams, ToolResult } from './types.js'
import type { ToolDefinition } from '../api/types.js'
import type { MeridianIndexer } from '../repo/meridian-indexer.js'

interface RepoGraphInput {
  from_file: string
  max_tokens?: number
  mode?: 'graph' | 'impact'
}

const DEFINITION: ToolDefinition = {
  name: 'repo_graph',
  description: `Query the code graph to find files and symbols structurally related to a given file.

### Modes
- **graph** (default): Returns ranked related files with exported symbols, ordered by call/import proximity.
- **impact**: Returns the blast radius of changes to the file — which files depend on it and which tests to run.

### When to use
- After reading a file, to find what it depends on or what depends on it
- Before editing, to understand the blast radius of a change (use mode: "impact")
- To navigate unfamiliar code by following structural connections
- After editing, to know which tests to run (use mode: "impact")

### How it works
The graph is built incrementally as you read/edit files. More files read = richer graph.`,
  input_schema: {
    type: 'object',
    properties: {
      from_file: { type: 'string', description: 'File path to find related code for (relative to project root)' },
      max_tokens: { type: 'number', default: 2000, description: 'Token budget for the response (controls how many files are returned)' },
      mode: { type: 'string', enum: ['graph', 'impact'], default: 'graph', description: 'Query mode: "graph" for related files, "impact" for blast radius analysis' },
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
      const mode = input.mode ?? 'graph'

      if (mode === 'impact') {
        return executeImpact(indexer, input.from_file)
      }

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

function executeImpact(indexer: MeridianIndexer, filePath: string): ToolResult {
  const result = indexer.impact([filePath])

  if (result.totalImpact === 0 && result.tests.length === 0) {
    return { content: `No known dependents for \`${filePath}\`. The graph may need more files indexed.` }
  }

  const lines: string[] = [
    `## Impact Analysis: \`${filePath}\``,
    `Total impacted: ${result.totalImpact} files`,
    '',
  ]

  if (result.direct.length > 0) {
    lines.push(`### Direct dependents (${result.direct.length})`)
    for (const f of result.direct) lines.push(`- ${f}`)
    lines.push('')
  }

  if (result.transitive.length > 0) {
    lines.push(`### Transitive dependents (${result.transitive.length})`)
    for (const f of result.transitive.slice(0, 20)) lines.push(`- ${f}`)
    if (result.transitive.length > 20) lines.push(`- ...(${result.transitive.length - 20} more)`)
    lines.push('')
  }

  if (result.tests.length > 0) {
    lines.push(`### Tests to run (${result.tests.length})`)
    for (const f of result.tests) lines.push(`- ${f}`)
    lines.push('')
  }

  return { content: lines.join('\n') }
}
