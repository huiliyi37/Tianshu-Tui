import type { SearchBackend, SearchFetch, SearchResult } from './types.js'

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

/**
 * Free, zero-config fallback backend. Scrapes the html.duckduckgo.com lite
 * endpoint — no API key required, so `isAvailable()` is always true.
 */
export class DuckDuckGoBackend implements SearchBackend {
  readonly name = 'duckduckgo'

  constructor(private readonly fetchImpl: SearchFetch) {}

  isAvailable(): boolean {
    return true
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const url = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`
    // redirect:'manual' — the lite endpoint returns 200 directly. Refusing to
    // auto-follow redirects avoids being bounced to an unvalidated host (a 3xx
    // simply surfaces as a non-ok status and the chain falls through).
    const response = await this.fetchImpl(url, {
      signal,
      headers: { 'User-Agent': 'terminal-coding-agent/1.0' },
      redirect: 'manual',
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const html = await response.text()
    return parseDuckDuckGoResults(html, count)
  }
}
