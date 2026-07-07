/**
 * Zero-dependency CDP (Chrome DevTools Protocol) client.
 *
 * Transport is Node's built-in `WebSocket` (Node 22+, verified on Node 24) —
 * no ws/playwright/puppeteer dependency. Discovery goes over plain `fetch`
 * against the DevTools HTTP endpoint (`/json/version`, `/json/list`,
 * `/json/new`, `/json/close`).
 *
 * The connection speaks "flat" protocol mode: one browser-level WebSocket,
 * page/iframe targets attached via `Target.attachToTarget(flatten: true)`
 * and addressed per-request with `sessionId`. Request/response correlation
 * is by monotonically increasing `id`; every request carries its own
 * timeout so a wedged renderer can't hang the tool forever.
 *
 * `CdpTransport` is injectable so unit tests drive the client with a fake
 * transport (no real Chrome needed) — mirrors JxaRunner/PowerShellRunner
 * injection in the native drivers.
 */

/** Minimal WebSocket-ish transport. Injectable for tests. */
export interface CdpTransport {
  send(data: string): void
  close(): void
}

export interface CdpTransportHandlers {
  onMessage(data: string): void
  onClose(): void
}

export type CdpTransportFactory = (wsUrl: string, handlers: CdpTransportHandlers) => Promise<CdpTransport>

/** Default request timeout (ms). Snapshot-ish calls pass their own. */
const DEFAULT_REQUEST_TIMEOUT_MS = 10_000

/** Connect timeout for the WebSocket itself (ms). */
const CONNECT_TIMEOUT_MS = 5_000

/** Default transport: Node's built-in WebSocket. */
export const defaultTransportFactory: CdpTransportFactory = (wsUrl, handlers) => {
  return new Promise<CdpTransport>((resolve, reject) => {
    const ws = new WebSocket(wsUrl)
    const timer = setTimeout(() => {
      try { ws.close() } catch { /* already closed */ }
      reject(new Error(`CDP WebSocket connect timeout (${CONNECT_TIMEOUT_MS}ms): ${wsUrl}`))
    }, CONNECT_TIMEOUT_MS)
    ws.addEventListener('open', () => {
      clearTimeout(timer)
      resolve({
        send: (data) => ws.send(data),
        close: () => { try { ws.close() } catch { /* already closed */ } },
      })
    })
    ws.addEventListener('error', () => {
      clearTimeout(timer)
      reject(new Error(`CDP WebSocket connect failed: ${wsUrl}`))
    })
    ws.addEventListener('message', (ev) => {
      handlers.onMessage(typeof ev.data === 'string' ? ev.data : String(ev.data))
    })
    ws.addEventListener('close', () => handlers.onClose())
  })
}

export type CdpEventHandler = (params: Record<string, unknown>, sessionId: string | undefined) => void

interface PendingRequest {
  resolve: (result: Record<string, unknown>) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
  method: string
}

export interface CdpSendOptions {
  sessionId?: string
  timeoutMs?: number
}

/**
 * One CDP WebSocket connection (browser endpoint, flat mode).
 * Correlates requests by id, routes events by method (+sessionId available
 * to the handler), rejects all in-flight requests on close.
 */
export class CdpConnection {
  private transport: CdpTransport | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private readonly eventHandlers = new Map<string, Set<CdpEventHandler>>()
  private closed = false

  static async connect(wsUrl: string, transportFactory: CdpTransportFactory = defaultTransportFactory): Promise<CdpConnection> {
    const conn = new CdpConnection()
    conn.transport = await transportFactory(wsUrl, {
      onMessage: (data) => conn.dispatch(data),
      onClose: () => conn.handleClose(),
    })
    return conn
  }

  get isClosed(): boolean {
    return this.closed
  }

  /** Send one CDP command and await its result (per-request timeout). */
  send<T = Record<string, unknown>>(method: string, params?: Record<string, unknown>, opts?: CdpSendOptions): Promise<T> {
    if (this.closed || !this.transport) {
      return Promise.reject(new Error(`CDP connection is closed (sending ${method})`))
    }
    const id = this.nextId++
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const msg: Record<string, unknown> = { id, method, params: params ?? {} }
    if (opts?.sessionId) msg.sessionId = opts.sessionId
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`CDP request timeout (${timeoutMs}ms): ${method}`))
      }, timeoutMs)
      this.pending.set(id, {
        resolve: resolve as (result: Record<string, unknown>) => void,
        reject,
        timer,
        method,
      })
      try {
        this.transport!.send(JSON.stringify(msg))
      } catch (err) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`CDP send failed for ${method}: ${(err as Error).message}`))
      }
    })
  }

  /** Subscribe to a CDP event by method name. Returns an unsubscribe fn. */
  on(method: string, handler: CdpEventHandler): () => void {
    let set = this.eventHandlers.get(method)
    if (!set) {
      set = new Set()
      this.eventHandlers.set(method, set)
    }
    set.add(handler)
    return () => { set.delete(handler) }
  }

  /** Wait for one event matching a predicate (with timeout). */
  waitForEvent(
    method: string,
    predicate: (params: Record<string, unknown>, sessionId: string | undefined) => boolean,
    timeoutMs: number,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const off = this.on(method, (params, sessionId) => {
        if (!predicate(params, sessionId)) return
        clearTimeout(timer)
        off()
        resolve(params)
      })
      const timer = setTimeout(() => {
        off()
        reject(new Error(`CDP event timeout (${timeoutMs}ms): ${method}`))
      }, timeoutMs)
    })
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    try { this.transport?.close() } catch { /* already closed */ }
    this.failAllPending(new Error('CDP connection closed'))
  }

  private handleClose(): void {
    if (this.closed) return
    this.closed = true
    this.failAllPending(new Error('CDP connection closed by remote'))
  }

  private failAllPending(err: Error): void {
    for (const [, req] of this.pending) {
      clearTimeout(req.timer)
      req.reject(new Error(`${err.message} (in-flight: ${req.method})`))
    }
    this.pending.clear()
  }

  private dispatch(data: string): void {
    let msg: Record<string, unknown>
    try {
      msg = JSON.parse(data) as Record<string, unknown>
    } catch {
      return // non-JSON frame — ignore
    }
    const id = msg.id
    if (typeof id === 'number') {
      const req = this.pending.get(id)
      if (!req) return
      this.pending.delete(id)
      clearTimeout(req.timer)
      const error = msg.error as { message?: string; code?: number } | undefined
      if (error) {
        req.reject(new Error(`CDP ${req.method} failed: ${error.message ?? 'unknown error'}`))
      } else {
        req.resolve((msg.result ?? {}) as Record<string, unknown>)
      }
      return
    }
    const method = msg.method
    if (typeof method !== 'string') return
    const handlers = this.eventHandlers.get(method)
    if (!handlers || handlers.size === 0) return
    const params = (msg.params ?? {}) as Record<string, unknown>
    const sessionId = typeof msg.sessionId === 'string' ? msg.sessionId : undefined
    for (const handler of [...handlers]) {
      try {
        handler(params, sessionId)
      } catch { /* event handlers must not break dispatch */ }
    }
  }
}

// --- HTTP discovery layer (DevTools endpoint) ---

export interface CdpVersionInfo {
  webSocketDebuggerUrl: string
  browser: string
}

export interface CdpTargetInfo {
  id: string
  type: string
  title: string
  url: string
  webSocketDebuggerUrl?: string
}

export type FetchLike = (url: string, init?: { method?: string; signal?: AbortSignal }) => Promise<{
  ok: boolean
  status: number
  json(): Promise<unknown>
  text(): Promise<string>
}>

const HTTP_TIMEOUT_MS = 3_000

async function httpJson<T>(url: string, fetchImpl: FetchLike, method: 'GET' | 'PUT' = 'GET'): Promise<T> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetchImpl(url, { method, signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`)
    return (await res.json()) as T
  } finally {
    clearTimeout(timer)
  }
}

/** `/json/version` — browser identity + browser-level WebSocket URL. */
export async function discoverBrowser(httpBase: string, fetchImpl: FetchLike = fetch): Promise<CdpVersionInfo> {
  const info = await httpJson<{ webSocketDebuggerUrl?: string; Browser?: string }>(`${httpBase}/json/version`, fetchImpl)
  if (!info.webSocketDebuggerUrl) {
    throw new Error(`DevTools endpoint at ${httpBase} exposes no webSocketDebuggerUrl`)
  }
  return { webSocketDebuggerUrl: info.webSocketDebuggerUrl, browser: info.Browser ?? 'unknown' }
}

/** `/json/list` — enumerate open targets (pages, workers, iframes). */
export async function listTargets(httpBase: string, fetchImpl: FetchLike = fetch): Promise<CdpTargetInfo[]> {
  const raw = await httpJson<CdpTargetInfo[]>(`${httpBase}/json/list`, fetchImpl)
  return Array.isArray(raw) ? raw : []
}

/** `/json/new?url=` — open a new tab. Chrome 111+ requires PUT; fall back to
 *  GET for older Chromium forks. */
export async function openTarget(httpBase: string, url: string, fetchImpl: FetchLike = fetch): Promise<CdpTargetInfo> {
  const endpoint = `${httpBase}/json/new?${encodeURIComponent(url)}`
  try {
    return await httpJson<CdpTargetInfo>(endpoint, fetchImpl, 'PUT')
  } catch {
    return await httpJson<CdpTargetInfo>(endpoint, fetchImpl, 'GET')
  }
}

/** `/json/close/{id}` — close a tab. */
export async function closeTarget(httpBase: string, targetId: string, fetchImpl: FetchLike = fetch): Promise<void> {
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), HTTP_TIMEOUT_MS)
  try {
    const res = await fetchImpl(`${httpBase}/json/close/${targetId}`, { signal: ctrl.signal })
    if (!res.ok) throw new Error(`HTTP ${res.status} closing target ${targetId}`)
  } finally {
    clearTimeout(timer)
  }
}

/** Quick health probe: does anything answer `/json/version` here? */
export async function probeEndpoint(httpBase: string, fetchImpl: FetchLike = fetch): Promise<boolean> {
  try {
    await discoverBrowser(httpBase, fetchImpl)
    return true
  } catch {
    return false
  }
}
