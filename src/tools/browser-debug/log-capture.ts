/**
 * browser-debug/log-capture — console + network event buffer.
 */

export type ConsoleLevel = 'log' | 'info' | 'warn' | 'error' | 'debug'

export interface ConsoleEntry {
  level: ConsoleLevel
  text: string
  ts: number
}

export interface NetworkEntry {
  requestId: string
  method: string
  url: string
  status?: number
  startedAt: number
  durationMs?: number
  failed?: boolean
  errorText?: string
  resourceType?: string
  contentType?: string
  responseBody?: string
  responseBodyTruncated?: boolean
}

export interface NetworkQuery {
  failedOnly?: boolean
  urlFilter?: string
  apiOnly?: boolean
}

export const MAX_RESPONSE_BODY = 2048
const MAX_CONSOLE = 500
const MAX_NETWORK = 500
const API_RESOURCE_TYPES = new Set(['xhr', 'fetch'])

/** Normalise arbitrary console type strings to our small level set. */
export function normalizeConsoleLevel(raw: string): ConsoleLevel {
  switch (raw) {
    case 'error':
      return 'error'
    case 'warning':
    case 'warn':
      return 'warn'
    case 'info':
      return 'info'
    case 'debug':
    case 'verbose':
      return 'debug'
    default:
      return 'log'
  }
}

/** `[error] Uncaught TypeError…` — prefix drives TUI severity colouring. */
export function formatConsoleLine(entry: ConsoleEntry): string {
  const text = entry.text.replace(/\s+$/, '')
  return `[${entry.level}] ${text}`
}

/** Single-line network render with a status-aware leading glyph. */
export function formatNetworkLine(entry: NetworkEntry, includeBody = false): string {
  const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
  let line: string
  if (entry.failed) {
    line = `✗ ${entry.method} ${entry.url}${entry.errorText ? ` (${entry.errorText})` : ''}`
  } else if (entry.status === undefined) {
    line = `→ ${entry.method} ${entry.url}`
  } else {
    line = `← ${entry.status} ${entry.method} ${entry.url}${dur}`
  }
  if (entry.resourceType) line += ` [${entry.resourceType}]`
  if (includeBody && entry.responseBody) {
    const suffix = entry.responseBodyTruncated ? ' …(body truncated)' : ''
    line += `\n  body: ${entry.responseBody}${suffix}`
  }
  return line
}

/** Multi-line detail for network_detail action. */
export function formatNetworkDetail(entry: NetworkEntry): string {
  const lines = [
    `id: ${entry.requestId}`,
    `method: ${entry.method}`,
    `url: ${entry.url}`,
  ]
  if (entry.resourceType) lines.push(`type: ${entry.resourceType}`)
  if (entry.failed) {
    lines.push(`status: failed${entry.errorText ? ` (${entry.errorText})` : ''}`)
  } else if (entry.status !== undefined) {
    lines.push(`status: ${entry.status}`)
  } else {
    lines.push('status: pending')
  }
  if (entry.durationMs !== undefined) lines.push(`duration: ${entry.durationMs}ms`)
  if (entry.contentType) lines.push(`content-type: ${entry.contentType}`)
  if (entry.responseBody) {
    lines.push('body:')
    lines.push(entry.responseBody)
    if (entry.responseBodyTruncated) lines.push('… (body truncated at 2048 chars)')
  } else {
    lines.push('body: (not captured)')
  }
  return lines.join('\n')
}

/** Whether the driver should async-capture response body for this request. */
export function shouldCaptureResponseBody(resourceType: string | undefined, status: number): boolean {
  if (resourceType && API_RESOURCE_TYPES.has(resourceType)) return true
  return status >= 400
}

/** Truncate response text for storage. */
export function truncateResponseBody(text: string): { body: string; truncated: boolean } {
  if (text.length <= MAX_RESPONSE_BODY) return { body: text, truncated: false }
  return { body: text.slice(0, MAX_RESPONSE_BODY), truncated: true }
}

export class LogCapture {
  private consoleEntries: ConsoleEntry[] = []
  private readonly network = new Map<string, NetworkEntry>()
  private networkOrder: string[] = []

  addConsole(level: ConsoleLevel, text: string, ts: number = Date.now()): ConsoleEntry {
    const entry: ConsoleEntry = { level, text, ts }
    this.consoleEntries.push(entry)
    if (this.consoleEntries.length > MAX_CONSOLE) {
      this.consoleEntries = this.consoleEntries.slice(-MAX_CONSOLE)
    }
    return entry
  }

  startRequest(
    requestId: string,
    method: string,
    url: string,
    ts: number = Date.now(),
    resourceType?: string,
  ): NetworkEntry {
    const prev = this.network.get(requestId)
    const entry: NetworkEntry = {
      requestId,
      method,
      url,
      startedAt: ts,
      resourceType: resourceType ?? prev?.resourceType,
      status: prev?.status,
      durationMs: prev?.durationMs,
      failed: prev?.failed,
      errorText: prev?.errorText,
      contentType: prev?.contentType,
      responseBody: prev?.responseBody,
      responseBodyTruncated: prev?.responseBodyTruncated,
    }
    this.upsert(entry)
    return entry
  }

  completeRequest(
    requestId: string,
    status: number,
    ts: number = Date.now(),
    resourceType?: string,
  ): NetworkEntry {
    const prev = this.network.get(requestId)
    const entry: NetworkEntry = {
      requestId,
      method: prev?.method ?? 'GET',
      url: prev?.url ?? '',
      startedAt: prev?.startedAt ?? ts,
      status,
      durationMs: prev ? Math.max(0, ts - prev.startedAt) : undefined,
      resourceType: resourceType ?? prev?.resourceType,
      contentType: prev?.contentType,
      responseBody: prev?.responseBody,
      responseBodyTruncated: prev?.responseBodyTruncated,
    }
    this.upsert(entry)
    return entry
  }

  failRequest(
    requestId: string,
    method: string,
    url: string,
    errorText?: string,
    ts: number = Date.now(),
    resourceType?: string,
  ): NetworkEntry {
    const prev = this.network.get(requestId)
    const entry: NetworkEntry = {
      requestId,
      method: prev?.method ?? method,
      url: prev?.url ?? url,
      startedAt: prev?.startedAt ?? ts,
      failed: true,
      errorText,
      durationMs: prev ? Math.max(0, ts - prev.startedAt) : undefined,
      resourceType: resourceType ?? prev?.resourceType,
      contentType: prev?.contentType,
      responseBody: prev?.responseBody,
      responseBodyTruncated: prev?.responseBodyTruncated,
    }
    this.upsert(entry)
    return entry
  }

  attachResponseBody(requestId: string, body: string, contentType?: string): NetworkEntry | null {
    const prev = this.network.get(requestId)
    if (!prev) return null
    const { body: trimmed, truncated } = truncateResponseBody(body)
    const entry: NetworkEntry = {
      ...prev,
      contentType: contentType ?? prev.contentType,
      responseBody: trimmed,
      responseBodyTruncated: truncated,
    }
    this.network.set(requestId, entry)
    return entry
  }

  private upsert(entry: NetworkEntry): void {
    if (!this.network.has(entry.requestId)) {
      this.networkOrder.push(entry.requestId)
      if (this.networkOrder.length > MAX_NETWORK) {
        const evicted = this.networkOrder.shift()
        if (evicted) this.network.delete(evicted)
      }
    }
    this.network.set(entry.requestId, entry)
  }

  getConsole(level?: ConsoleLevel): ConsoleEntry[] {
    return level ? this.consoleEntries.filter((e) => e.level === level) : [...this.consoleEntries]
  }

  getNetwork(query: NetworkQuery | boolean = false): NetworkEntry[] {
    const opts: NetworkQuery = typeof query === 'boolean' ? { failedOnly: query } : query
    let all = this.networkOrder.map((id) => this.network.get(id)).filter((e): e is NetworkEntry => !!e)
    if (opts.failedOnly) {
      all = all.filter((e) => e.failed || (e.status !== undefined && e.status >= 400))
    }
    if (opts.urlFilter) {
      const f = opts.urlFilter
      all = all.filter((e) => e.url.includes(f))
    }
    if (opts.apiOnly) {
      all = all.filter((e) => e.resourceType && API_RESOURCE_TYPES.has(e.resourceType))
    }
    return all
  }

  getByRequestId(requestId: string): NetworkEntry | undefined {
    return this.network.get(requestId)
  }

  clear(): void {
    this.consoleEntries = []
    this.network.clear()
    this.networkOrder = []
  }
}
