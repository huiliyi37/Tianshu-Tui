/**
 * browser-debug/session — per-sessionKey persistent browser sessions.
 *
 * Desktop runs multiple agent sessions in parallel; each gets its own browser
 * instance keyed by params.sessionId (TUI falls back to __default__).
 */

import {
  LogCapture,
  normalizeConsoleLevel,
  formatConsoleLine,
  formatNetworkLine,
} from './log-capture.js'
import {
  defaultDriverFactory,
  type BrowserDebugDriver,
  type BrowserDebugDriverFactory,
  type DriverEvents,
} from './driver.js'

export const DEFAULT_SESSION_KEY = '__default__'

export type BrowserSessionMode = 'launch' | 'connect'

export interface OpenSessionOptions {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
}

export type OutputSink = (chunk: string) => void

export class BrowserDebugSession {
  readonly sessionKey: string
  readonly driver: BrowserDebugDriver
  readonly log = new LogCapture()
  readonly headless: boolean
  readonly mode: BrowserSessionMode
  readonly connectUrl?: string
  readonly userDataDir?: string
  private outputSink: OutputSink | null = null

  private constructor(
    sessionKey: string,
    driver: BrowserDebugDriver,
    headless: boolean,
    mode: BrowserSessionMode,
    meta: { connectUrl?: string; userDataDir?: string },
  ) {
    this.sessionKey = sessionKey
    this.driver = driver
    this.headless = headless
    this.mode = mode
    this.connectUrl = meta.connectUrl
    this.userDataDir = meta.userDataDir
  }

  setOutputSink(sink: OutputSink | null): void {
    this.outputSink = sink
  }

  private emit(line: string): void {
    try {
      this.outputSink?.(line.endsWith('\n') ? line : line + '\n')
    } catch {
      /* ignore */
    }
  }

  static async open(opts: OpenSessionOptions): Promise<BrowserDebugSession> {
    const mode: BrowserSessionMode = opts.connectUrl ? 'connect' : 'launch'
    let self: BrowserDebugSession | null = null
    const events: DriverEvents = {
      onConsole: (rawLevel, text) => {
        const level = normalizeConsoleLevel(rawLevel)
        const entry = self!.log.addConsole(level, text)
        self!.emit(formatConsoleLine(entry))
      },
      onRequestStart: (id, method, url, resourceType) => {
        const entry = self!.log.startRequest(id, method, url, Date.now(), resourceType)
        self!.emit(formatNetworkLine(entry))
      },
      onResponse: (id, status, resourceType) => {
        const entry = self!.log.completeRequest(id, status, Date.now(), resourceType)
        self!.emit(formatNetworkLine(entry))
      },
      onRequestFailed: (id, method, url, errorText, resourceType) => {
        const entry = self!.log.failRequest(id, method, url, errorText, Date.now(), resourceType)
        self!.emit(formatNetworkLine(entry))
      },
      onResponseBody: (id, body, contentType) => {
        self!.log.attachResponseBody(id, body, contentType)
      },
    }
    const factory = opts.driverFactory ?? defaultDriverFactory
    const driver = await factory({
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      connectUrl: opts.connectUrl,
      events,
    })
    self = new BrowserDebugSession(opts.sessionKey, driver, opts.headless, mode, {
      connectUrl: opts.connectUrl,
      userDataDir: mode === 'launch' ? opts.userDataDir : undefined,
    })
    return self
  }

  async close(): Promise<void> {
    try {
      await this.driver.close()
    } finally {
      this.log.clear()
      this.outputSink = null
    }
  }
}

const sessions = new Map<string, BrowserDebugSession>()
const opening = new Map<string, Promise<BrowserDebugSession>>()
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    for (const s of sessions.values()) {
      void s.close().catch(() => {})
    }
    sessions.clear()
    opening.clear()
  }
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

export function resolveSessionKey(sessionId?: string): string {
  return sessionId?.trim() ? sessionId.trim() : DEFAULT_SESSION_KEY
}

export async function getOrCreateSession(opts: {
  sessionKey: string
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
}): Promise<BrowserDebugSession> {
  const key = opts.sessionKey
  const existing = sessions.get(key)
  if (existing) return existing

  const inflight = opening.get(key)
  if (inflight) return inflight

  installExitHook()
  const promise = BrowserDebugSession.open({
    sessionKey: key,
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    connectUrl: opts.connectUrl,
    driverFactory: opts.driverFactory,
  })
    .then((s) => {
      sessions.set(key, s)
      opening.delete(key)
      return s
    })
    .catch((err) => {
      opening.delete(key)
      throw err
    })
  opening.set(key, promise)
  return promise
}

export function getSession(sessionKey: string = DEFAULT_SESSION_KEY): BrowserDebugSession | null {
  return sessions.get(sessionKey) ?? null
}

export async function closeSession(sessionKey: string = DEFAULT_SESSION_KEY): Promise<void> {
  const s = sessions.get(sessionKey)
  sessions.delete(sessionKey)
  opening.delete(sessionKey)
  if (s) await s.close()
}

/** Test hook: drop all sessions without touching real browsers. */
export function __resetSessionForTest(): void {
  sessions.clear()
  opening.clear()
}

/** Test hook: count open sessions. */
export function __sessionCountForTest(): number {
  return sessions.size
}
