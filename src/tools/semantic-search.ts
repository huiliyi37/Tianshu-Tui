import type { Tool, ToolCallParams } from './types.js'
import { ensureSemanticIndex } from '../search/semantic-index.js'

export const SEMANTIC_SEARCH_TOOL: Tool = {
  definition: {
    name: 'semantic_search',
    description: `Search the codebase by meaning using a local BM25 index.

Use when grep/glob cannot find code by concept (e.g. "authentication middleware", "session persistence").
Rebuild the index with /index or by setting rebuild: true if results seem stale.`,
    input_schema: {
      type: 'object',
      properties: {
        query: { type: 'string', description: 'Natural language or keyword query' },
        limit: { type: 'integer', description: 'Max results (default 10)' },
        rebuild: { type: 'boolean', description: 'Force rebuild index before search' },
      },
      required: ['query'],
    },
  },

  async execute(params: ToolCallParams) {
    const query = String(params.input.query ?? '').trim()
    if (!query) {
      return { content: 'Error: query is required', isError: true }
    }

    const limit = Math.min(Number(params.input.limit) || 10, 25)
    const idx = ensureSemanticIndex(params.cwd)

    if (params.input.rebuild === true) {
      const stats = idx.rebuild()
      const hits = idx.search(query, limit)
      if (hits.length === 0) {
        return { content: `Index rebuilt (${stats.indexed} files). No matches for: ${query}` }
      }
      const lines = hits.map(h =>
        `${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(2)})\n${h.text.slice(0, 200)}`,
      )
      return { content: `Index rebuilt (${stats.indexed} files). Top ${hits.length} matches:\n\n${lines.join('\n\n---\n\n')}` }
    }

    const hits = idx.search(query, limit)
    if (hits.length === 0) {
      return { content: `No semantic matches for: ${query}\nTry rebuild: true or run /index` }
    }

    const lines = hits.map(h =>
      `${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(2)})\n${h.text.slice(0, 300)}`,
    )
    return { content: `Top ${hits.length} matches:\n\n${lines.join('\n\n---\n\n')}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
