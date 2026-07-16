/**
 * 统一 proxy 解析组件。
 *
 * 优先级（高 → 低）：config.network.proxy > HTTPS_PROXY/HTTP_PROXY 环境变量 > 直连。
 * NO_PROXY 匹配的域名始终直连，无论 proxy 来自 config 还是环境变量。
 *
 * 抽取自 `src/tui/updater.ts` 的 `proxyForUrl` + `shouldBypassProxy`，扩展支持
 * config 注入，供 http-fetch / updater / 未来统一网络层复用。
 */

export interface ProxyResolverOptions {
  /** config.network.proxy 显式配置（优先于环境变量）。 */
  proxyUrl?: string
  /** config.network.noProxy（逗号分隔，支持 * / . 前缀 / 精确匹配）。 */
  noProxy?: string
}

function envCaseInsensitive(key: string): string | undefined {
  return process.env[key] ?? process.env[key.toLowerCase()]
}

/**
 * hostname 是否命中 NO_PROXY 绕过列表。
 *
 * 匹配规则（与 curl/wget 语义对齐）：
 *  - `*` 绕过所有
 *  - 精确域名匹配（大小写不敏感）
 *  - `.example.com` 后缀匹配：`api.example.com` 和 `example.com` 都命中
 */
export function shouldBypassProxy(hostname: string, noProxy?: string): boolean {
  const raw = noProxy ?? envCaseInsensitive('NO_PROXY')
  if (!raw) return false
  const h = hostname.toLowerCase()
  for (const entry of raw.split(',')) {
    const p = entry.trim().toLowerCase()
    if (!p) continue
    if (p === '*') return true
    if (h === p) return true
    if (p.startsWith('.') && (h.endsWith(p) || h === p.slice(1))) return true
  }
  return false
}

/**
 * 解析某个 URL 应该走哪个代理。
 *
 * @returns proxy URL 字符串，或 `undefined`（直连）。
 *
 * 优先级：
 *   1. `opts.proxyUrl`（config.network.proxy）—— 设了就用，不再读环境变量
 *   2. 环境变量 HTTPS_PROXY / HTTP_PROXY（按 URL 协议选择，大小写不敏感）
 *   3. undefined（直连）
 *
 * NO_PROXY 命中时一律返回 undefined，无论 proxy 来源。
 */
export function resolveProxyForUrl(url: string, opts?: ProxyResolverOptions): string | undefined {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return undefined
  }
  if (shouldBypassProxy(parsed.hostname, opts?.noProxy)) return undefined

  // config 显式配置优先
  if (opts?.proxyUrl) return opts.proxyUrl

  // 回退到环境变量
  if (parsed.protocol === 'https:') {
    return envCaseInsensitive('HTTPS_PROXY') ?? envCaseInsensitive('HTTP_PROXY')
  }
  if (parsed.protocol === 'http:') {
    return envCaseInsensitive('HTTP_PROXY') ?? envCaseInsensitive('HTTPS_PROXY')
  }
  return undefined
}
