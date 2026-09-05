import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAuthorizedRequest } from './auth.js'
import { allowedCorsOrigin } from './cors.js'
import { errorContext, serverLogger } from './logger.js'

// 10MB — the prompt route carries up to 4 base64 image data URLs. Compressed
// images are ~256KB each, but the per-image server cap is 1.5MB decoded
// (~2MB base64), so 4 images plus prompt JSON must fit. The server is a
// localhost-bound, token-gated sidecar, so a larger ceiling is acceptable.
const MAX_BODY_BYTES = 10 * 1024 * 1024

export interface RouteResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
  /** Handler already took ownership of the ServerResponse (e.g. SSE). */
  handled?: boolean
}

export type RouteHandler = (
  body: unknown,
  params?: Record<string, string>,
  headers?: Record<string, string>,
  res?: ServerResponse,
) => RouteResponse | Promise<RouteResponse>

export function createRouter(routes: Record<string, RouteHandler>) {
  // Build exact match map + parameterized routes
  const exact = new Map<string, RouteHandler>()
  const parameterized: Array<{ method: string; pattern: RegExp; paramNames: string[]; handler: RouteHandler }> = []

  for (const [key, handler] of Object.entries(routes)) {
    const parts = key.split(' ')
    const method = parts[0]!
    const path = parts.slice(1).join(' ')
    if (path.includes(':')) {
      // Parameterized route: /tasks/:id → capture group
      const paramNames: string[] = []
      const regexStr = path.replace(/:(\w+)/g, (_, name) => {
        paramNames.push(name)
        return '([^/]+)'
      })
      parameterized.push({
        method,
        pattern: new RegExp('^' + regexStr + '$'),
        paramNames,
        handler,
      })
    } else {
      exact.set(key, handler)
    }
  }

  return async (
    method: string,
    path: string,
    body: unknown,
    reqHeaders?: Record<string, string>,
    res?: ServerResponse,
  ): Promise<RouteResponse> => {
    // Strip query string from path, but surface query params to handlers so
    // routes like `GET /sessions/:id/events?since=N` can read them.
    const qIdx = path.indexOf('?')
    const cleanPath = qIdx >= 0 ? path.slice(0, qIdx) : path
    const query: Record<string, string> = {}
    if (qIdx >= 0) {
      for (const [k, v] of new URLSearchParams(path.slice(qIdx + 1))) query[k] = v
    }

    // Try exact match first
    const exactKey = method + ' ' + cleanPath
    const exactHandler = exact.get(exactKey)
    if (exactHandler) return await exactHandler(body, query, reqHeaders, res)

    // Try parameterized routes. Match on BOTH method and path so a GET and a
    // POST can share the same parameterized path (e.g. GET/POST
    // /sessions/:id/skills) without the first-registered one shadowing the other.
    for (const { method: routeMethod, pattern, paramNames, handler } of parameterized) {
      if (routeMethod !== method) continue
      const match = cleanPath.match(pattern)
      if (match) {
        const params: Record<string, string> = { ...query }
        for (let i = 0; i < paramNames.length; i++) {
          params[paramNames[i]!] = match[i + 1]!
        }
        return await handler(body, params, reqHeaders, res)
      }
    }

    return { status: 404, body: { error: 'Not found' } }
  }
}

export interface StartServerOptions {
  /** 监听地址。默认 127.0.0.1；显式设 LAN IP / 0.0.0.0 开启远程访问。 */
  host?: string
  /** Host header allowlist（不带端口）。配置后非回环 Host 仅 allowlist 放行。 */
  allowedHosts?: string[]
}

/** 绑定地址是否为回环形态（决定是否进入 LAN 模式）。 */
function isLoopbackBind(addr: string): boolean {
  const a = addr.toLowerCase()
  return a === '127.0.0.1' || a === 'localhost' || a === '::1' || a === '::'
}

/** Host header 的回环形态（带/不带端口）。 */
function isLoopbackHostHeader(h: string, p: number): boolean {
  return h === `127.0.0.1:${p}` || h === `localhost:${p}` || h === `[::1]:${p}`
    || h === '127.0.0.1' || h === 'localhost' || h === '[::1]'
}

/** 去 Host 端口：[::1]:8080 → [::1]；127.0.0.1:9 → 127.0.0.1；hostname:8080 → hostname。 */
function stripHostPort(h: string): string {
  if (h.startsWith('[')) {
    const end = h.indexOf(']')
    return end >= 0 ? h.slice(0, end + 1) : h
  }
  const colon = h.lastIndexOf(':')
  return colon > 0 ? h.slice(0, colon) : h
}

export async function startServer(
  port: number,
  routes: Record<string, RouteHandler>,
  apiToken?: string,
  opts: StartServerOptions = {},
): Promise<{ close: (cb?: (err?: Error) => void) => void; port: number }> {
  const router = createRouter(routes)

  // CORS：只反射已知 webview 来源（见 cors.ts——SSE/图片路由同源反射）。
  const corsOrigin = allowedCorsOrigin

  const bindHost = opts.host?.trim() || '127.0.0.1'
  // LAN 模式：显式绑定到非回环地址（0.0.0.0 / LAN IP / ::）。
  const lanMode = !isLoopbackBind(bindHost)
  const allowlist = (opts.allowedHosts ?? []).map((h) => h.trim().toLowerCase()).filter(Boolean)
  const allowlistConfigured = allowlist.length > 0

  // Host 校验三分支：DNS rebinding 让浏览器带着攻击者域名的 Host 直连本机端口。
  // ① 无 Host（HTTP/1.0 工具客户端）与回环形态恒放行（默认行为，回归保护）；
  // ② allowlist 配置后非回环 Host 仅精确匹配（去端口比较）；
  // ③ 未配 allowlist 的 LAN 模式放行任意 Host——此时 Bearer 是唯一凭证
  // （auth 校验紧随其后强制执行），DNS-rebinding 取舍见 P1 Mobile Remote 文档。
  const isHostAllowed = (host: string | undefined, p: number): boolean => {
    if (host === undefined) return true
    const h = host.toLowerCase()
    if (isLoopbackHostHeader(h, p)) return true
    if (allowlistConfigured) return allowlist.includes(stripHostPort(h))
    return lanMode
  }

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqHeaders = normalizeHeaders(req)

    if (!isHostAllowed(req.headers.host, boundPort)) {
      res.writeHead(403, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Forbidden: Host not allowed' }))
      return
    }

    const origin = corsOrigin(reqHeaders)
    if (req.method === 'OPTIONS') {
      res.writeHead(204, {
        ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
        'Access-Control-Allow-Methods': 'GET, POST, DELETE, PUT, PATCH, OPTIONS',
        'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      })
      res.end()
      return
    }

    // Health endpoint is intentionally not auth-gated — the desktop shell and
    // Rust monitor probe it from cold-start / token-rotation windows where the
    // Bearer token may not be available yet. No user data is exposed.
    // Use startsWith so /health?foo=bar also bypasses auth.
    const isHealth = req.url?.startsWith('/health') ?? false
    if (!isHealth && !isAuthorizedRequest({ headers: reqHeaders }, apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const body = await readBody(req)
    if (body === BODY_TOO_LARGE) {
      res.writeHead(413, { 'Content-Type': 'application/json', ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}) })
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    const result = await router(req.method ?? 'GET', req.url ?? '/', body, reqHeaders, res)
    if (result.handled) return
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      ...(origin ? { 'Access-Control-Allow-Origin': origin } : {}),
      ...result.headers,
    }
    res.writeHead(result.status, headers)
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

  let boundPort = port
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, bindHost, () => {
      server.removeListener('error', reject)
      // port 0 → 系统分配，回显实际端口（真实 HTTP 测试与横幅依赖它）。
      const addr = server.address()
      if (addr && typeof addr === 'object') boundPort = addr.port
      resolve()
    })
  })
  return { close: (cb) => server.close(cb), port: boundPort }
}

const BODY_TOO_LARGE = Symbol('body-too-large')

type ReadBodyResult = unknown | typeof BODY_TOO_LARGE

function normalizeHeaders(req: IncomingMessage): Record<string, string> {
  const reqHeaders: Record<string, string> = {}
  for (const [k, v] of Object.entries(req.headers)) {
    if (typeof v === 'string') reqHeaders[k.toLowerCase()] = v
    else if (Array.isArray(v)) reqHeaders[k.toLowerCase()] = v[0] ?? ''
  }
  return reqHeaders
}

async function readBody(req: IncomingMessage): Promise<ReadBodyResult> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const buffer = chunk as Buffer
    total += buffer.length
    if (total > MAX_BODY_BYTES) {
      req.destroy()
      return BODY_TOO_LARGE
    }
    chunks.push(buffer)
  }
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    serverLogger.warn('Invalid JSON request body', { ...errorContext(err) })
    return {}
  }
}
