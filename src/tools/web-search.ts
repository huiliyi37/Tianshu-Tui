import type { Tool, ToolCallParams, ToolResult } from './types.js'

const MAX_RESULTS = 20
const TIMEOUT_MS = 15_000

interface SearchResult {
  title: string
  url: string
  snippet: string
}

/**
 * Parse DuckDuckGo HTML search results from the lite endpoint.
 * The HTML structure is relatively stable:
 *   <div class="result">
 *     <h2 class="result__title"><a class="result__a" href="URL">TITLE</a></h2>
 *     <a class="result__snippet" href="URL">SNIPPET</a>
 *   </div>
 */
export function parseDuckDuckGoResults(html: string, maxCount: number): SearchResult[] {
  const results: SearchResult[] = []

  const titleBlocks = html.split('<h2 class="result__title">')
  for (let i = 1; i < titleBlocks.length && results.length < maxCount; i++) {
    const block = titleBlocks[i]!

    const linkMatch = block.match(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i)
    if (!linkMatch) continue
    const url = decodeHtmlEntities(linkMatch[1]!)
    // strip tags first, then decode entities → human-readable text for the model
    const title = decodeHtmlEntities(stripHtml(linkMatch[2]!)).trim()
    if (!title || !url) continue

    const snippetMatch = block.match(/<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/i)
    const snippet = snippetMatch ? decodeHtmlEntities(stripHtml(snippetMatch[1]!)).trim() : ''

    const actualUrl = extractActualUrl(url)

    results.push({ title, url: actualUrl, snippet })
  }

  return results
}

function stripHtml(text: string): string {
  return text.replace(/<[^>]+>/g, '').trim()
}

/**
 * Decode HTML entities — named (&amp; &lt; …) and numeric (&#92; &#x27;).
 * Single-pass: matched entities are replaced once and not re-scanned, so
 * `&amp;#x27;` decodes to the literal `&#x27;`, never double-decoded to `'`.
 */
export function decodeHtmlEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#\d+|amp|lt|gt|quot|apos|#39);/g, (m, e: string) => {
    switch (e) {
      case 'amp': return '&'
      case 'lt': return '<'
      case 'gt': return '>'
      case 'quot': return '"'
      case 'apos':
      case '#39': return "'"
    }
    // numeric: &#92; (decimal) or &#x27; (hex)
    const code = e[1] === 'x' || e[1] === 'X'
      ? parseInt(e.slice(2), 16)
      : parseInt(e.slice(1), 10)
    return Number.isFinite(code) && code > 0 ? String.fromCodePoint(code) : m
  })
}

/** Extract actual target URL from DuckDuckGo redirect wrappers. Validates http/https only. */
function extractActualUrl(ddgUrl: string): string {
  try {
    const parsed = new URL(ddgUrl.replace(/^\/\//, 'https://'))
    const uddg = parsed.searchParams.get('uddg')
    if (uddg) {
      const decoded = decodeURIComponent(uddg)
      return /^https?:\/\//i.test(decoded) ? decoded : ddgUrl
    }
    const u = parsed.searchParams.get('u')
    if (u) {
      const decoded = decodeURIComponent(u)
      return /^https?:\/\//i.test(decoded) ? decoded : ddgUrl
    }
  } catch {
    // Not a valid URL — use as-is
  }
  return ddgUrl
}

export const WEB_SEARCH_TOOL: Tool = {
  definition: {
    name: 'web_search',
    description: 'Search the web for real-time information. Results include titles, URLs, and content summaries from search engines.',
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

    try {
      const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`

      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), TIMEOUT_MS)

      let response: Response
      try {
        response = await fetch(url, {
          signal: controller.signal,
          headers: { 'User-Agent': 'terminal-coding-agent/1.0' },
        })
      } finally {
        clearTimeout(timeoutId)
      }

      if (!response.ok) {
        return { content: `Search request failed: HTTP ${response.status}`, isError: true }
      }

      const html = await response.text()
      const results = parseDuckDuckGoResults(html, count)

      if (results.length === 0) {
        return { content: `No search results found for: "${query}"` }
      }

      const formatted = results
        .map((r, i) => `${i + 1}. [${r.title}](${r.url})\n   ${r.snippet}`)
        .join('\n\n')

      return { content: `Web search results for "${query}":\n\n${formatted}` }
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') {
        return { content: `Search timed out after ${TIMEOUT_MS / 1000}s for: "${query}"`, isError: true }
      }
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Search failed: ${message}`, isError: true }
    }
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
