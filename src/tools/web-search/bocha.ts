import type { SearchBackend, SearchFetch, SearchResult } from './types.js'

const BOCHA_ENDPOINT = 'https://api.bochaai.com/v1/web-search'

/**
 * 博查（Bocha）Web Search API 响应。
 * 字段结构来自 InternLM/lagent 的 BochaBrowser 实现（经 MindSearch 实测）：
 *   { code, data: { webPages: { value: [{ name, url, snippet, summary, ... }] } } }
 * `summary` 是博查 AI 生成的页面摘要（质量高于 raw `snippet`），优先取用。
 */
interface BochaResponse {
  code?: number
  msg?: string
  data?: {
    webPages?: {
      value?: Array<{
        name?: string
        url?: string
        snippet?: string
        summary?: string
        siteName?: string
        datePublished?: string
      }>
    }
  }
}

/**
 * Bocha (博查) Search API backend — 国内直连的 AI 搜索引擎。
 *
 * 与 Brave/Tavily 同构的付费 API 后端，但 `api.bochaai.com` 在国内直连可达，
 * 是 Tavily 在国内 AI agent 圈的标准替代。需要 API key（open.bochaai.com 申请，
 * 有免费额度），未配置时 `isAvailable()` 返回 false，链自动跳过。
 *
 * `summary:true` 请求博查为每条结果生成 AI 摘要 —— 比裸 snippet 信息密度更高，
 * 对下游模型更有用。响应 `summary` 字段优先于 `snippet`。
 *
 * Docs: https://open.bochaai.com/ ｜ MCP 参考: https://github.com/BochaAI/bocha-search-mcp
 */
export class BochaBackend implements SearchBackend {
  readonly name = 'bocha'

  constructor(
    private readonly fetchImpl: SearchFetch,
    private readonly apiKey: string | undefined,
  ) {}

  isAvailable(): boolean {
    return typeof this.apiKey === 'string' && this.apiKey.length > 0
  }

  async search(query: string, count: number, signal: AbortSignal): Promise<SearchResult[]> {
    const response = await this.fetchImpl(BOCHA_ENDPOINT, {
      signal,
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey ?? ''}`,
      },
      body: JSON.stringify({ query, count, summary: true }),
    })
    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`)
    }
    const data = (await response.json()) as BochaResponse
    // 博查业务错误（如 key 无效）HTTP 可能仍 200，靠 code/msg 兜底判败
    if (data.code && data.code !== 200) {
      throw new Error(`bocha ${data.code}: ${data.msg ?? 'unknown error'}`)
    }
    const raw = data.data?.webPages?.value ?? []
    const results: SearchResult[] = []
    for (const r of raw) {
      if (!r.url || !r.name) continue
      // summary（AI 摘要）优先，缺省回退 snippet
      const snippet = r.summary || r.snippet || ''
      const result: SearchResult = { title: r.name, url: r.url, snippet }
      // siteName / datePublished 让模型判断来源可信度与时效（博查独有，可选）
      if (r.siteName) result.siteName = r.siteName
      if (r.datePublished) result.publishedAt = r.datePublished
      results.push(result)
      if (results.length >= count) break
    }
    return results
  }
}
