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
  /** Request headers captured at request start (for API联调). */
  requestHeaders?: Record<string, string>
  /** Request payload (POST body) captured at request start, truncated. */
  requestBody?: string
  requestBodyTruncated?: boolean
  /** Response headers captured on response. */
  responseHeaders?: Record<string, string>
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

/** A network line parsed back into fields, for structured (desktop) rendering. */
export interface ParsedNetworkRow {
  dir: 'ok' | 'pending' | 'failed'
  method: string
  url: string
  status?: number
  durationMs?: number
  resourceType?: string
  errorText?: string
}

/**
 * Inverse of {@link formatNetworkLine} for the primary (non-body) line. Returns
 * null for anything that is not a network line (console/cookie/storage output,
 * body continuation lines, placeholders). Kept next to the formatter so the two
 * stay in sync; the desktop renders a table from these rows.
 */
export function parseNetworkLine(line: string): ParsedNetworkRow | null {
  let rest = line.replace(/\s+$/, '')
  let resourceType: string | undefined
  const typeMatch = rest.match(/ \[(\w+)\]$/)
  if (typeMatch) {
    resourceType = typeMatch[1]
    rest = rest.slice(0, rest.length - typeMatch[0].length)
  }
  if (rest.startsWith('✗ ')) {
    rest = rest.slice(2)
    let errorText: string | undefined
    const errMatch = rest.match(/ \((.+)\)$/)
    if (errMatch) {
      errorText = errMatch[1]
      rest = rest.slice(0, rest.length - errMatch[0].length)
    }
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    return { dir: 'failed', method: rest.slice(0, sp), url: rest.slice(sp + 1), errorText, resourceType }
  }
  if (rest.startsWith('→ ')) {
    rest = rest.slice(2)
    const sp = rest.indexOf(' ')
    if (sp < 0) return null
    return { dir: 'pending', method: rest.slice(0, sp), url: rest.slice(sp + 1), resourceType }
  }
  if (rest.startsWith('← ')) {
    rest = rest.slice(2)
    let durationMs: number | undefined
    const durMatch = rest.match(/ \((\d+)ms\)$/)
    if (durMatch) {
      durationMs = Number(durMatch[1])
      rest = rest.slice(0, rest.length - durMatch[0].length)
    }
    const firstSp = rest.indexOf(' ')
    if (firstSp < 0) return null
    const status = Number(rest.slice(0, firstSp))
    if (!Number.isFinite(status)) return null
    const afterStatus = rest.slice(firstSp + 1)
    const secondSp = afterStatus.indexOf(' ')
    if (secondSp < 0) return null
    return {
      dir: 'ok',
      status,
      method: afterStatus.slice(0, secondSp),
      url: afterStatus.slice(secondSp + 1),
      durationMs,
      resourceType,
    }
  }
  return null
}

/** Severity bucket for a single browser_debug output line. */
export type BrowserDebugLineKind = 'error' | 'warn' | 'ok' | 'pending' | 'muted'

/**
 * Classify one browser_debug output line by its console level / HTTP status,
 * from the line prefix alone. Shared by the TUI (`colorBrowserDebugLine`) and
 * the desktop renderer so both surfaces agree on severity.
 *
 * Console lines are prefixed `[error]/[warn]/[info]/[log]/[debug]`; network
 * lines start with `✗` (failed), `→` (pending) or `← STATUS …` (completed).
 */
export function classifyBrowserDebugLine(line: string): BrowserDebugLineKind {
  if (line.startsWith('[error]')) return 'error'
  if (line.startsWith('[warn]')) return 'warn'
  if (line.startsWith('[info]') || line.startsWith('[log]') || line.startsWith('[debug]')) {
    return 'muted'
  }
  if (line.startsWith('✗')) return 'error'
  if (line.startsWith('→')) return 'pending'
  if (line.startsWith('←')) {
    const status = Number(line.slice(1).trim().split(/\s+/)[0])
    if (Number.isFinite(status)) {
      if (status >= 500) return 'error'
      if (status >= 400) return 'warn'
      if (status >= 200 && status < 300) return 'ok'
    }
    return 'muted'
  }
  return 'muted'
}

/** Header names whose values must never be printed in full (tokens/cookies).
 *  Security gate: no raw API keys / OAuth tokens / passwords in the transcript. */
const SENSITIVE_HEADERS = new Set([
  'authorization', 'proxy-authorization', 'cookie', 'set-cookie',
  'x-api-key', 'api-key', 'x-auth-token', 'x-csrf-token',
])

/** Redact sensitive header values to `***(…last4)` while keeping the key visible,
 *  so the user still sees the header is present without leaking the secret. */
export function maskSensitiveHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [rawKey, value] of Object.entries(headers)) {
    out[rawKey] = SENSITIVE_HEADERS.has(rawKey.toLowerCase()) && value ? maskSecretValue(value) : value
  }
  return out
}

/** Mask a secret value to `***(…last4)`, keeping the last 4 chars for diagnosis. */
export function maskSecretValue(value: string): string {
  const tail = value.length > 4 ? value.slice(-4) : ''
  return `***(…${tail})`
}

/** Storage keys whose values likely hold secrets (masked in `storage` output). */
const SENSITIVE_KEY_RE = /(token|secret|auth|session|jwt|password|passwd|api[-_]?key|credential|refresh|access)/i
const STORAGE_VALUE_MAX = 200

interface CookieLike {
  name: string
  value: string
  domain?: string
  path?: string
  httpOnly?: boolean
  secure?: boolean
  sameSite?: string
}

/** Render cookies one per line with masked values (cookies carry session ids). */
export function formatCookies(cookies: CookieLike[]): string {
  if (cookies.length === 0) return '(no cookies)'
  return cookies.map((c) => {
    const flags = [
      c.domain || c.path ? `${c.domain ?? ''}${c.path ?? ''}` : '',
      c.httpOnly ? 'httpOnly' : '',
      c.secure ? 'secure' : '',
      c.sameSite ? `sameSite=${c.sameSite}` : '',
    ].filter(Boolean).join('; ')
    return `${c.name}=${maskSecretValue(c.value)}${flags ? `  [${flags}]` : ''}`
  }).join('\n')
}

/** Render a storage snapshot; mask values whose key looks sensitive, else truncate. */
export function formatStorage(record: Record<string, string>): string {
  const keys = Object.keys(record)
  if (keys.length === 0) return '(empty)'
  return keys.map((k) => {
    const v = record[k] ?? ''
    if (SENSITIVE_KEY_RE.test(k)) return `${k}: ${maskSecretValue(v)}`
    const shown = v.length > STORAGE_VALUE_MAX ? `${v.slice(0, STORAGE_VALUE_MAX)}… (truncated)` : v
    return `${k}: ${shown}`
  }).join('\n')
}

function appendHeaderBlock(lines: string[], label: string, headers?: Record<string, string>): void {
  if (!headers || Object.keys(headers).length === 0) return
  lines.push(`${label}:`)
  const masked = maskSensitiveHeaders(headers)
  for (const [k, v] of Object.entries(masked)) lines.push(`  ${k}: ${v}`)
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
  appendHeaderBlock(lines, 'request headers', entry.requestHeaders)
  if (entry.requestBody) {
    lines.push('request body:')
    lines.push(entry.requestBody)
    if (entry.requestBodyTruncated) lines.push('… (request body truncated at 2048 chars)')
  }
  appendHeaderBlock(lines, 'response headers', entry.responseHeaders)
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
    headers?: Record<string, string>,
    postData?: string,
  ): NetworkEntry {
    const prev = this.network.get(requestId)
    let requestBody = prev?.requestBody
    let requestBodyTruncated = prev?.requestBodyTruncated
    if (postData !== undefined) {
      const { body, truncated } = truncateResponseBody(postData)
      requestBody = body
      requestBodyTruncated = truncated
    }
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
      requestHeaders: headers ?? prev?.requestHeaders,
      requestBody,
      requestBodyTruncated,
      responseHeaders: prev?.responseHeaders,
    }
    this.upsert(entry)
    return entry
  }

  completeRequest(
    requestId: string,
    status: number,
    ts: number = Date.now(),
    resourceType?: string,
    responseHeaders?: Record<string, string>,
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
      requestHeaders: prev?.requestHeaders,
      requestBody: prev?.requestBody,
      requestBodyTruncated: prev?.requestBodyTruncated,
      responseHeaders: responseHeaders ?? prev?.responseHeaders,
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
      requestHeaders: prev?.requestHeaders,
      requestBody: prev?.requestBody,
      requestBodyTruncated: prev?.requestBodyTruncated,
      responseHeaders: prev?.responseHeaders,
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
