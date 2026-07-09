import type { SearchBackend, SearchFetch, SearchResult } from './types.js'

const BRAVE_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search'

interface BraveResponse {
  web?: {
    results?: Array<{ title?: string; url?: string; description?: string }>
  }
}

/**
 * Brave Search API backend. Requires an API key (subscription token). Available
 * only when a key was resolved from config; otherwise the chain skips it.
 * Docs: https://api-dashboard.search.brave.com/app/documentation/web-search
 */
export class BraveBackend implements SearchBackend {
  readonly name = 'brave'

  constructor(
    private readonly fetchImpl: SearchFetch,
    private readonly apiKey: string | undefined,
    private readonly region?: string,
  ) {}

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const params = new URLSearchParams({ q: query, count: String(count) })
    if (this.region) params.set('country', this.region)
    const response = await this.fetchImpl(`${BRAVE_ENDPOINT}?${params.toString()}`, {
      signal,
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip',
        'X-Subscription-Token': this.apiKey ?? '',
      },
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as BraveResponse
    const raw = data.web?.results ?? []
    const results: SearchResult[] = []
    for (const r of raw) {
      if (!r.url || !r.title) continue
      results.push({ title: r.title, url: r.url, snippet: r.description ?? '' })
      if (results.length >= count) break
    }
    return results
  }
}
