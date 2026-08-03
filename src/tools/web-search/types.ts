/**
 * Web search backend abstraction.
 *
 * A `SearchBackend` is one concrete search provider (DuckDuckGo scrape, Brave
 * API, Tavily API, …). Backends are tried in config order by `runBackendChain`
 * — the first available backend that returns a non-empty result wins, and the
 * rest are skipped. This lets a free scrape backend act as a zero-config
 * fallback behind optional paid API backends.
 */

export interface SearchResult {
  title: string
  url: string
  snippet: string
  /** 来源站点名（如「知乎」「GitHub」），便于模型判断来源可信度。可选——仅博查等
   *  返回 siteName 的后端填充；bing/DDG scrape 不提供。 */
  siteName?: string
  /** 发布时间（ISO 字符串），便于时效性判断。可选。 */
  publishedAt?: string
}

/** Injectable fetch — production uses `globalThis.fetch`; tests pass a stub. */
export type SearchFetch = (url: string, init?: RequestInit) => Promise<Response>

export interface SearchBackend {
  /** Stable identifier used in config `backends` list and result attribution. */
  readonly name: string
  /** False when a required credential is missing — the chain skips it silently. */
  isAvailable(): boolean
  /**
   * Run one search. Throws on network/HTTP failure (the chain records the error
   * and falls through). Returns [] when the query legitimately has no hits.
   * `signal` carries the per-backend timeout from the chain.
   */
  search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]>
}
