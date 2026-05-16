import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'

export interface RouteResponse {
  status: number
  body?: unknown
  headers?: Record<string, string>
}

export type RouteHandler = (body: unknown) => RouteResponse | Promise<RouteResponse>

export function createRouter(routes: Record<string, RouteHandler>) {
  return async (method: string, path: string, body: unknown): Promise<RouteResponse> => {
    const key = `${method} ${path}`
    const handler = routes[key]
    if (!handler) return { status: 404, body: { error: 'Not found' } }
    return await handler(body)
  }
}

export function startServer(port: number, routes: Record<string, RouteHandler>): { close: () => void } {
  const router = createRouter(routes)

  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const body = await readBody(req)
    const result = await router(req.method ?? 'GET', req.url ?? '/', body)
    const headers: Record<string, string> = { 'Content-Type': 'application/json', ...result.headers }
    res.writeHead(result.status, headers)
    res.end(result.body ? JSON.stringify(result.body) : '')
  })

  server.listen(port)
  return { close: () => server.close() }
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const raw = Buffer.concat(chunks).toString()
  if (!raw) return {}
  try { return JSON.parse(raw) } catch { return {} }
}
