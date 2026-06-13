import type { Tool, ToolCallParams } from './types.js'
import { ensureSemanticIndex } from '../search/semantic-index.js'
import { createEmbeddingProvider } from '../search/embedding-provider.js'

export const SEMANTIC_SEARCH_TOOL: Tool = {
  definition: {
    name: 'semantic_search',
    description: `Search the codebase by meaning. Uses a hybrid of BM25 (lexical) and embedding-based vector search (RRF-fused) when an embedding provider is configured, and degrades to BM25 offline.

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
    const idx = ensureSemanticIndex(params.cwd, createEmbeddingProvider())

    const fmt = (hits: Array<{ file: string; startLine: number; endLine: number; text: string; score: number }>) =>
      hits.map(h => `${h.file}:${h.startLine}-${h.endLine} (score ${h.score.toFixed(3)})\n${h.text.slice(0, 300)}`)

    if (params.input.rebuild === true) {
      const stats = idx.rebuild()
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `Index rebuilt (${stats.indexed} files). No matches for: ${query}` }
      }
      return { content: `Index rebuilt (${stats.indexed} files, ${backend}). Top ${hits.length} matches:\n\n${fmt(hits).join('\n\n---\n\n')}` }
    }

    // Auto-incremental update when stale (lazy refresh)
    if (idx.isStale()) {
      const update = idx.incrementalUpdate()
      const note = update.fallbackRebuild
        ? ` (full rebuild: ${update.reindexed} files)`
        : ` (${update.reindexed} changed, ${update.removed} removed)`
      const { hits, backend } = await idx.searchHybrid(query, limit)
      if (hits.length === 0) {
        return { content: `Index refreshed${note}. No matches for: ${query}` }
      }
      return { content: `Index refreshed${note} (${backend}). Top ${hits.length} matches:\n\n${fmt(hits).join('\n\n---\n\n')}` }
    }

    const { hits, backend } = await idx.searchHybrid(query, limit)
    if (hits.length === 0) {
      return { content: `No semantic matches for: ${query}\nTry rebuild: true or run /index` }
    }
    return { content: `Top ${hits.length} matches (${backend}):\n\n${fmt(hits).join('\n\n---\n\n')}` }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
