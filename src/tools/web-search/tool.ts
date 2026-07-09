import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import type { SearchBackend, SearchFetch } from './types.js'
import { DuckDuckGoBackend } from './duckduckgo.js'
import { runBackendChain } from './chain.js'

const MAX_RESULTS = 20
const DEFAULT_TIMEOUT_MS = 15_000

export interface WebSearchDeps {
  /** Ordered backend chain. Defaults to DuckDuckGo-only (zero-config). */
  backends?: SearchBackend[]
  /** Per-backend timeout. Defaults to 15s. */
  timeoutMs?: number
  /** Injectable fetch for the default DDG backend (tests). */
  fetch?: SearchFetch
}

export function createWebSearchTool(deps: WebSearchDeps = {}): Tool {
  const fetchImpl = deps.fetch ?? (globalThis.fetch.bind(globalThis) as SearchFetch)
  const backends = deps.backends && deps.backends.length > 0
    ? deps.backends
    : [new DuckDuckGoBackend(fetchImpl)]
  const timeoutMs = deps.timeoutMs ?? DEFAULT_TIMEOUT_MS

  return {
    definition: {
      name: 'web_search',
      description: `Search the web for real-time information. Results include titles, URLs, and content summaries.

### When to search
- Current/time-sensitive facts (latest releases, breaking changes, today's status)
- A specific library/version/API/error you don't recognize or can't recall precisely
- Anything that may have changed since your training cutoff
- Unrecognized capitalized names (products, tools, packages): an unfamiliar name is more likely a real thing that postdates training than something to guess at — search rather than confabulate

### When NOT to search
- Stable facts, language syntax, or well-established concepts you already know
- Code already present in this repo — use grep/read_file/semantic_search instead

### Using results (attribution and copyright)
- Synthesize and paraphrase in your own words; cite the source URL for non-obvious claims
- Keep any direct quote short (under ~15 words) and use at most one quote per source
- Never reproduce article paragraphs, song lyrics, or poems verbatim
- Follow web_fetch to read a full page when a snippet is insufficient`,
      input_schema: {
        type: 'object',
        properties: {
          query: {
            type: 'string',
            description: 'The search query string',
          },
          count: {
            type: 'number',
            description: 'Number of results to return (default: 10, max: 20)',
          },
        },
        required: ['query'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const rawQuery = params.input.query
      if (typeof rawQuery !== 'string' || rawQuery.trim().length === 0) {
        return { content: 'Error: query must be a non-empty string.', isError: true }
      }
      const query = rawQuery.trim()
      const rawCount = params.input.count
      const count = Math.min(
        Math.max(1, typeof rawCount === 'number' ? rawCount : 10),
        MAX_RESULTS,
      )

      const { backend, results, errors } = await runBackendChain(backends, query, count, timeoutMs)

      if (results.length === 0) {
        // All backends failed → surface why. All backends empty → benign no-hit.
        const hardErrors = errors.filter(e => e.message !== 'no results')
        if (hardErrors.length > 0) {
          const detail = hardErrors.map(e => `${e.backend}: ${e.message}`).join('; ')
          return { content: `Search failed (${detail})`, isError: true }
        }
        return { content: `No search results found for: "${query}"` }
      }

      const formatted = results
        .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
        .join('\n\n')

      const via = backend ? ` (via ${backend})` : ''
      return { content: `Web search results for "${query}"${via}:\n\n${formatted}` }
    },

    requiresApproval(): boolean {
      return true
    },

    isConcurrencySafe(): boolean {
      return true
    },

    isEnabled(): boolean {
      return true
    },
  }
}

/** Default DDG-only tool instance — preserved for existing imports. */
export const WEB_SEARCH_TOOL: Tool = createWebSearchTool()
