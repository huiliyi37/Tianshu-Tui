/**
 * browser-debug/log-capture — console + network event buffer.
 *
 * UI-agnostic: the driver feeds raw console/network events in, the tool reads
 * them back for `console` / `network` actions, and each event is also rendered
 * to a single line (with a machine-parsable prefix) so the TUI/desktop can
 * colour by severity without re-parsing structured objects.
 *
 * Line prefixes are intentionally stable so `src/tui/format/tool-card.ts` can
 * classify a streamed line:
 *   console → `[error] …` `[warn] …` `[log] …`
 *   network → `→ GET  /url`  (pending)   `← 200 GET /url (12ms)`  (done)
 *                                          `✗ GET /url (net::ERR…)` (failed)
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
}

const MAX_CONSOLE = 500
const MAX_NETWORK = 500

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
export function formatNetworkLine(entry: NetworkEntry): string {
  const dur = entry.durationMs !== undefined ? ` (${entry.durationMs}ms)` : ''
  if (entry.failed) {
    return `✗ ${entry.method} ${entry.url}${entry.errorText ? ` (${entry.errorText})` : ''}`
  }
  if (entry.status === undefined) {
    return `→ ${entry.method} ${entry.url}`
  }
  return `← ${entry.status} ${entry.method} ${entry.url}${dur}`
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

  /** Record a request as it starts (status undefined = pending). */
  startRequest(requestId: string, method: string, url: string, ts: number = Date.now()): NetworkEntry {
    const entry: NetworkEntry = { requestId, method, url, startedAt: ts }
    this.upsert(entry)
    return entry
  }

  /** Complete a request with a response status; computes durationMs when possible. */
  completeRequest(requestId: string, status: number, ts: number = Date.now()): NetworkEntry {
    const prev = this.network.get(requestId)
    const entry: NetworkEntry = {
      requestId,
      method: prev?.method ?? 'GET',
      url: prev?.url ?? '',
      startedAt: prev?.startedAt ?? ts,
      status,
      durationMs: prev ? Math.max(0, ts - prev.startedAt) : undefined,
    }
    this.upsert(entry)
    return entry
  }

  /** Mark a request as failed (network error, not an HTTP error status). */
  failRequest(requestId: string, method: string, url: string, errorText?: string, ts: number = Date.now()): NetworkEntry {
    const prev = this.network.get(requestId)
    const entry: NetworkEntry = {
      requestId,
      method: prev?.method ?? method,
      url: prev?.url ?? url,
      startedAt: prev?.startedAt ?? ts,
      failed: true,
      errorText,
      durationMs: prev ? Math.max(0, ts - prev.startedAt) : undefined,
    }
    this.upsert(entry)
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

  /** Console entries, optionally filtered to a single level, most-recent-last. */
  getConsole(level?: ConsoleLevel): ConsoleEntry[] {
    return level ? this.consoleEntries.filter((e) => e.level === level) : [...this.consoleEntries]
  }

  /**
   * Network entries in start order. `failedOnly` keeps only failures and
   * HTTP error statuses (>=400) — the common "what broke" filter for API联调.
   */
  getNetwork(failedOnly = false): NetworkEntry[] {
    const all = this.networkOrder.map((id) => this.network.get(id)).filter((e): e is NetworkEntry => !!e)
    if (!failedOnly) return all
    return all.filter((e) => e.failed || (e.status !== undefined && e.status >= 400))
  }

  clear(): void {
    this.consoleEntries = []
    this.network.clear()
    this.networkOrder = []
  }
}
