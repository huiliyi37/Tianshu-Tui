/**
 * fetch-core — web_fetch 抓取主链路的共享内核。
 *
 * 管线（与 tool.ts 历史行为严格一致）：
 *   URL 校验 → maxAge 缓存命中直返 → httpFetchGuarded 直连 →
 *   坏状态码+实质内容视为成功 → htmlToMarkdownSmart 转换 →
 *   质量判败时 Playwright 渲染 → Jina 兜底 → 成功写缓存
 *
 * web_fetch 工具（tool.ts）与 web_crawl 复用同一管线——crawl 因此自动获得
 * 缓存、渲染降级与链接提取能力。actions 分支不进内核（crawl 不支持动作），
 * 仍由 tool.ts 在调用内核前处理。
 */
import { fetchCauseDetail } from '../../api/error-classifier.js'
import { httpFetchGuarded, type HttpFetchDeps, type HttpFetchOptions } from '../net/http-fetch.js'
import { SSRFError } from '../net/ssrf.js'
import {
  decodeBody,
  extractLinks,
  extractLinksFromMarkdown,
  htmlToMarkdownSmart,
  MIN_SUBSTANTIAL_LENGTH,
} from './extract.js'
import { fetchViaJina, isJinaQualityHeuristic } from './jina-fetch.js'
import { fetchViaPlaywright, type RenderFetchResult } from './render-fetch.js'
import type { RenderAction } from './render-actions.js'
import { FetchCache, getFetchCache } from './fetch-cache.js'

export interface FetchCoreDeps extends HttpFetchDeps {
  /** 测试注入：替换 Playwright 渲染路径（注入后无视 enablePlaywright 开关）。 */
  renderFetch?: (url: string, actions?: RenderAction[]) => Promise<RenderFetchResult | undefined>
  /** 测试注入：替换 maxAge 缓存（缺省用 <cwd>/.rivet/cache/web-fetch 文件缓存）。 */
  cache?: Pick<FetchCache, 'read' | 'write'>
}

export interface FetchMarkdownOptions extends HttpFetchOptions {
  /** 缓存目录推导基准（<cwd>/.rivet/cache/web-fetch）。 */
  cwd: string
  extractMainContent?: boolean
  /** 本地 Playwright 渲染 SPA 降级层（默认关；需 chromium 可用，桌面端内置）。 */
  enablePlaywright?: boolean
  renderTimeoutMs?: number
  renderWaitMs?: number
  /** 缓存读取有效期（默认 2 天；0 = 禁读仍写）。 */
  cacheMaxAgeMs?: number
  /** Jina Reader 基础地址（默认 https://r.jina.ai；国内可填自建反代）。 */
  jinaBaseUrl?: string
}

export interface FetchMarkdownOk {
  ok: true
  status: number
  markdown: string
  /** 抓取路径标记：（经 Playwright 渲染）/（经 Jina Reader）/ ''。 */
  via: string
  /** 转换前原始 HTML（或缓存/Jina markdown）提取的绝对链接——crawl 发现源。 */
  links: string[]
  /** 原始响应字节数（缓存命中时为 markdown 字符数）。 */
  rawBytes: number
  fromCache: boolean
  /** 仅缓存命中时存在（用于「N 分钟前抓取」呈现）。 */
  fetchedAt?: number
}

export interface FetchMarkdownError {
  ok: false
  error: string
  errorKind?: 'api_error'
}

export type FetchMarkdownOutcome = FetchMarkdownOk | FetchMarkdownError

const DEFAULT_TIMEOUT_MS = 15_000
const DEFAULT_MAX_BYTES = 10_485_760
const DEFAULT_MAX_REDIRECTS = 5
const DEFAULT_USER_AGENT = 'Tianshu/1.0 (terminal coding agent)'

const BINARY_CONTENT_TYPE_PREFIXES = [
  'image/',
  'application/pdf',
  'application/octet-stream',
  'video/',
  'audio/',
  'font/',
]

/** HTTP 状态码会留在文案里并命中 classifyFailure 的 api_error 正则——结构字段先行。 */
function httpApiErrorKind(status: number): 'api_error' | undefined {
  if (status === 429 || status === 500 || status === 502 || status === 503) return 'api_error'
  return undefined
}

export async function fetchMarkdown(
  rawUrl: string,
  deps: FetchCoreDeps,
  opts: FetchMarkdownOptions,
): Promise<FetchMarkdownOutcome> {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return { ok: false, error: `无效 URL：${rawUrl}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: `不支持的协议：${url.protocol}。仅允许 http 和 https。` }
  }

  const options = {
    timeoutMs: opts.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    maxResponseBytes: opts.maxResponseBytes ?? DEFAULT_MAX_BYTES,
    maxRedirects: opts.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
    userAgent: opts.userAgent ?? DEFAULT_USER_AGENT,
  }
  const extractMainContentEnabled = opts.extractMainContent ?? true

  // 三级降级的中间层：Playwright 本地渲染。仅在配置开启（或测试注入）时接入。
  const renderFetch =
    deps.renderFetch ??
    (opts.enablePlaywright
      ? (u: string) =>
          fetchViaPlaywright(u, {
            timeoutMs: opts.renderTimeoutMs,
            waitMs: opts.renderWaitMs,
            lookup: deps.lookup,
            extractMainContent: extractMainContentEnabled,
          })
      : undefined)

  // maxAge 缓存：命中在降级链最前端直接返回，不发起任何请求。
  const cache = deps.cache ?? getFetchCache(opts.cwd, { maxAgeMs: opts.cacheMaxAgeMs })
  const cacheVariant = `e${extractMainContentEnabled ? 1 : 0}`
  const cached = await cache.read(rawUrl, cacheVariant)
  if (cached) {
    return {
      ok: true,
      status: cached.status,
      markdown: cached.markdown,
      via: cached.via,
      links: extractLinksFromMarkdown(cached.markdown),
      rawBytes: cached.markdown.length,
      fromCache: true,
      fetchedAt: cached.fetchedAt,
    }
  }

  const writeCache = async (status: number, markdown: string, via: string): Promise<void> => {
    if (markdown.trim().length < MIN_SUBSTANTIAL_LENGTH) return // 只写实质内容（宁旧勿错）
    await cache.write(rawUrl, cacheVariant, { url: rawUrl, markdown, via, status })
  }

  try {
    const { status, contentType, bytes } = await httpFetchGuarded(rawUrl, deps, options)
    const contentTypeLower = contentType.toLowerCase()

    if (status >= 400) {
      // 坏状态码但有实质内容 → 视为成功（部分站点 403/404 页仍渲染真实内容）
      if (contentTypeLower.includes('text/html')) {
        const body = decodeBody(bytes, contentType)
        const md = await htmlToMarkdownSmart(body, {
          pageUrl: rawUrl,
          onlyMainContent: extractMainContentEnabled,
        })
        if (md.trim().length >= MIN_SUBSTANTIAL_LENGTH) {
          await writeCache(status, md, '')
          return {
            ok: true,
            status,
            markdown: md,
            via: '',
            links: extractLinks(body, rawUrl),
            rawBytes: bytes.length,
            fromCache: false,
          }
        }
      }
      return {
        ok: false,
        error: `HTTP ${status}：${rawUrl}`,
        ...(httpApiErrorKind(status) ? { errorKind: 'api_error' as const } : {}),
      }
    }

    if (BINARY_CONTENT_TYPE_PREFIXES.some((prefix) => contentTypeLower.includes(prefix))) {
      return {
        ok: false,
        error: `二进制内容（${contentType}）不会以文本返回。请使用 import_resource 下载此 URL。`,
      }
    }

    const body = decodeBody(bytes, contentType)

    let content: string
    let via = ''
    let links: string[] = []
    if (contentTypeLower.includes('text/html')) {
      // crawl 发现源：转换前从原始 HTML 提链接（sidebar/menu 目录链接会被黑名单
      // 清洗剔除，markdown 层再提就丢了）
      links = extractLinks(body, rawUrl)
      content = await htmlToMarkdownSmart(body, {
        pageUrl: rawUrl,
        onlyMainContent: extractMainContentEnabled,
      })
      // Quality heuristic: if local extraction looks bad (short, JS-only page),
      // render locally with Playwright first, then fall back to Jina Reader.
      if (isJinaQualityHeuristic(content)) {
        if (renderFetch) {
          const rendered = await renderFetch(rawUrl)
          // 渲染产出过薄（错误壳/白屏）视为渲染失败，落 Jina 兜底
          if (rendered && rendered.markdown.trim().length >= MIN_SUBSTANTIAL_LENGTH) {
            content = rendered.markdown
            via = '（经 Playwright 渲染）'
            links = rendered.links ?? extractLinksFromMarkdown(content)
          }
        }
        if (!via) {
          const jinaResult = await fetchViaJina(rawUrl, deps, {
            ...options,
            ...(opts.jinaBaseUrl ? { jinaBaseUrl: opts.jinaBaseUrl } : {}),
          })
          if (jinaResult) {
            content = jinaResult.markdown
            via = '（经 Jina Reader）'
            links = extractLinksFromMarkdown(content)
          }
        }
      }
    } else {
      content = body
    }

    await writeCache(status, content, via)
    return {
      ok: true,
      status,
      markdown: content,
      via,
      links,
      rawBytes: bytes.length,
      fromCache: false,
    }
  } catch (err) {
    if (err instanceof SSRFError) {
      return { ok: false, error: err.message }
    }
    const message = err instanceof Error ? err.message : String(err)
    const detail = fetchCauseDetail(err)
    const full = detail ? `${message}: ${detail}` : message
    return { ok: false, error: `抓取失败 ${rawUrl}：${full}` }
  }
}
