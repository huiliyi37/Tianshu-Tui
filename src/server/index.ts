import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { isAuthorizedRequest } from './auth.js'
import { errorContext, serverLogger } from './logger.js'

const MAX_BODY_BYTES = 1_048_576

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
  const parameterized: Array<{ pattern: RegExp; paramNames: string[]; handler: RouteHandler }> = []

  for (const [key, handler] of Object.entries(routes)) {
    const parts = key.split(' ')
    const method = parts[0]
    const path = parts.slice(1).join(' ')
    if (path.includes(':')) {
      // Parameterized route: /tasks/:id → capture group
      const paramNames: string[] = []
      const regexStr = path.replace(/:(\w+)/g, (_, name) => {
        paramNames.push(name)
        return '([^/]+)'
      })
      parameterized.push({
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
    // Strip query string from path
    const cleanPath = path.split('?')[0] ?? path

    // Try exact match first
    const exactKey = method + ' ' + cleanPath
    const exactHandler = exact.get(exactKey)
    if (exactHandler) return await exactHandler(body, undefined, reqHeaders, res)

    // Try parameterized routes
    for (const { pattern, paramNames, handler } of parameterized) {
      const match = cleanPath.match(pattern)
      if (match) {
        const params: Record<string, string> = {}
        for (let i = 0; i < paramNames.length; i++) {
          params[paramNames[i]!] = match[i + 1]!
        }
        return await handler(body, params, reqHeaders, res)
      }
    }

    return { status: 404, body: { error: 'Not found' } }
  }
}

export function startServer(port: number, routes: Record<string, RouteHandler>, apiToken?: string): { close: () => void } {
  const router = createRouter(routes)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const reqHeaders = normalizeHeaders(req)
    if (!isAuthorizedRequest({ headers: reqHeaders }, apiToken)) {
      res.writeHead(401, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Unauthorized' }))
      return
    }

    const body = await readBody(req)
    if (body === BODY_TOO_LARGE) {
      res.writeHead(413, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ error: 'Request body too large' }))
      return
    }

    const result = await router(req.method ?? 'GET', req.url ?? '/', body, reqHeaders, res)
    if (result.handled) return
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...result.headers }
    res.writeHead(result.status, headers)
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

  server.listen(port, '127.0.0.1')
  return { close: () => server.close() }
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
