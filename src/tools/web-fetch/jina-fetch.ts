/**
 * Jina Reader — server-side URL-to-Markdown conversion.
 *
 * Jina (https://r.jina.ai) renders any URL server-side and returns clean
 * Markdown via `Accept: text/plain`. It strips ads, navigation, and JS noise
 * — a higher-quality alternative to client-side turndown for complex pages.
 *
 * This module wraps the Jina API with the same proxy/SSRF/timeout guards
 * used by the main httpFetchGuarded path (via HttpFetchDeps + HttpFetchOptions),
 * so web_fetch can seamlessly fall back when local HTML→Markdown produces
 * low-quality output.
 */
import { httpFetchGuarded, type HttpFetchDeps, type HttpFetchOptions } from '../net/http-fetch.js'
import { SSRFError } from '../net/ssrf.js'

const DEFAULT_JINA_BASE = 'https://r.jina.ai'

/** Quality heuristic: local extraction likely failed if Markdown is tiny or
 *  contains a JS-render-page signal. These thresholds are conservative by
 *  design — we prefer a Jina re-fetch over silently returning garbage. */
export function isJinaQualityHeuristic(md: string): boolean {
  const trimmed = md.trim()
  // Empty / near-empty after extraction
  if (trimmed.length < 200) return true
  // Classic JS-rendered page hints. These signals indicate the server returned
  // a shell/error/challenge page instead of real content — trigger Jina
  // re-fetch rather than hand the user garbage. Keep this list to phrases that
  // would not appear in legitimate article content.
  const jsPageSignals = [
    'Please enable JavaScript',
    'Enable JavaScript',
    'This page requires JavaScript',
    'noscript',
    'Checking your browser',
    'Just a moment',
    'DDOS protection',
    'id="challenge-form"',
    // GitHub and similar SPA error shells — the page "loaded" but the app
    // failed to hydrate, leaving a stub error banner as the only content.
    'error while loading',
    'please reload this page',
    'uh oh',
  ]
  const lower = trimmed.toLowerCase()
  return jsPageSignals.some(s => lower.includes(s.toLowerCase()))
}

export interface JinaFetchResult {
  /** HTTP status from Jina's upstream fetch of the target URL. */
  sourceStatus: number
  /** Clean Markdown body (Jina returns text/plain). */
  markdown: string
  /** True when Jina successfully fetched the page and returned content. */
  ok: boolean
}

/**
 * Fetch a URL through the Jina Reader API using the same proxy/SSRF guards
 * as the main web_fetch path.
 *
 * Returns the Jina-processed Markdown, or throws on network/proxy/SSRF errors.
 * HTTP ≥400 from Jina are returned as `{ ok: false }` (non-throwing) so the
 * caller can fall back without a try/catch at every call site.
 */
export async function fetchViaJina(
  url: string,
  deps: HttpFetchDeps = {},
  options: HttpFetchOptions & { jinaBaseUrl?: string } = {},
): Promise<JinaFetchResult> {
  // 可配置 base：国内默认 r.jina.ai 直连不稳，用户可填自建反代域名规避。
  // 仅取 host（去尾斜杠），路径 `/`+目标 URL 的语义不变。
  const base = (options.jinaBaseUrl ?? DEFAULT_JINA_BASE).replace(/\/+$/, '')
  const jinaUrl = `${base}/${url}`

  // Reuse the exact same fetch pipeline: proxy resolution, SSRF pinning,
  // timeout, redirect limit, and body-size cap. Jina is just another HTTP
  // target — no special treatment needed.
  const { status, contentType, bytes } = await httpFetchGuarded(jinaUrl, deps, {
    ...options,
    // Jina's text/plain responses are usually much smaller than raw HTML.
    // Keep the same cap for consistency; if Jina returns oversized content
    // the caller can re-fetch the raw URL with a higher cap.
  })

  // Jina returns the SOURCE page's status in the x-status header when
  // available; fall back to Jina's own status.
  const body = new TextDecoder('utf-8', { fatal: false }).decode(bytes)
  const sourceStatus = status

  const ok = status >= 200 && status < 400 && body.trim().length > 0

  return { sourceStatus, markdown: body, ok }
}
