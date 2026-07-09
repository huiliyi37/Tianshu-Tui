import type { SearchBackend, SearchFetch, SearchResult } from './types.js'

const TAVILY_ENDPOINT = 'https://api.tavily.com/search'

interface TavilyResponse {
  results?: Array<{ title?: string; url?: string; content?: string }>
}

/**
 * Tavily Search API backend. Requires an API key. Available only when a key was
 * resolved from config; otherwise the chain skips it.
 * Docs: https://docs.tavily.com/documentation/api-reference/endpoint/search
 */
export class TavilyBackend implements SearchBackend {
  readonly name = 'tavily'

  constructor(
    private readonly fetchImpl: SearchFetch,
    private readonly apiKey: string | undefined,
  ) {}

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const response = await this.fetchImpl(TAVILY_ENDPOINT, {
      signal,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey ?? ''}`,
      },
      body: JSON.stringify({ query, max_results: count }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as TavilyResponse
    const raw = data.results ?? []
    const results: SearchResult[] = []
    for (const r of raw) {
      if (!r.url || !r.title) continue
      results.push({ title: r.title, url: r.url, snippet: r.content ?? '' })
      if (results.length >= count) break
    }
    return results
  }
}
