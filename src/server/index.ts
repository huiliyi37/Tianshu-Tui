import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { errorContext, serverLogger } from './logger.js'

export interface RouteResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export type RouteHandler = (body: unknown, params?: Record<string, string>, headers?: Record<string, string>) => RouteResponse | Promise<RouteResponse>

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

  return async (method: string, path: string, body: unknown, reqHeaders?: Record<string, string>): Promise<RouteResponse> => {
    // Strip query string from path
    const cleanPath = path.split('?')[0] ?? path

    // Try exact match first
    const exactKey = method + ' ' + cleanPath
    const exactHandler = exact.get(exactKey)
    if (exactHandler) return await exactHandler(body, undefined, reqHeaders)

    // Try parameterized routes
    for (const { pattern, paramNames, handler } of parameterized) {
      const match = cleanPath.match(pattern)
      if (match) {
        const params: Record<string, string> = {}
        for (let i = 0; i < paramNames.length; i++) {
          params[paramNames[i]!] = match[i + 1]!
        }
        return await handler(body, params, reqHeaders)
      }
    }

    return { status: 404, body: { error: 'Not found' } }
  }
}

export function startServer(port: number, routes: Record<string, RouteHandler>): { close: () => void } {
  const router = createRouter(routes)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req)
    const reqHeaders: Record<string, string> = {}
    for (const [k, v] of Object.entries(req.headers)) {
      if (typeof v === 'string') reqHeaders[k.toLowerCase()] = v
      else if (Array.isArray(v)) reqHeaders[k.toLowerCase()] = v[0] ?? ''
    }
    const result = await router(req.method ?? 'GET', req.url ?? '/', body, reqHeaders)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...result.headers }
    res.writeHead(result.status, headers)
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

  server.listen(port, '127.0.0.1')
  return { close: () => server.close() }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try {
    return JSON.parse(raw)
  } catch (err) {
    serverLogger.warn('Invalid JSON request body', { ...errorContext(err) })
    return {}
  }
}
