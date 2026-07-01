/**
 * browser-debug/session — process-level persistent browser session.
 *
 * Supports two modes:
 *  - launch — Playwright persistent context (profile dir under ~/.rivet);
 *  - connect — attach to existing Chrome via CDP (--remote-debugging-port).
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

export type BrowserSessionMode = 'launch' | 'connect'

export interface OpenSessionOptions {
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
}

/** Sink for live event lines (wired to the current tool call's params.onOutput). */
export type OutputSink = (chunk: string) => void

export class BrowserDebugSession {
  readonly driver: BrowserDebugDriver
  readonly log = new LogCapture()
  readonly headless: boolean
  readonly mode: BrowserSessionMode
  readonly connectUrl?: string
  readonly userDataDir?: string
  private outputSink: OutputSink | null = null

  private constructor(
    driver: BrowserDebugDriver,
    headless: boolean,
    mode: BrowserSessionMode,
    meta: { connectUrl?: string; userDataDir?: string },
  ) {
    this.driver = driver
    this.headless = headless
    this.mode = mode
    this.connectUrl = meta.connectUrl
    this.userDataDir = meta.userDataDir
  }

  /** Point live events at the current tool call's output stream. */
  setOutputSink(sink: OutputSink | null): void {
    this.outputSink = sink
  }

  private emit(line: string): void {
    try {
      this.outputSink?.(line.endsWith('\n') ? line : line + '\n')
    } catch {
      /* a broken sink must never crash the browser session */
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
      onRequestStart: (id, method, url) => {
        const entry = self!.log.startRequest(id, method, url)
        self!.emit(formatNetworkLine(entry))
      },
      onResponse: (id, status) => {
        const entry = self!.log.completeRequest(id, status)
        self!.emit(formatNetworkLine(entry))
      },
      onRequestFailed: (id, method, url, errorText) => {
        const entry = self!.log.failRequest(id, method, url, errorText)
        self!.emit(formatNetworkLine(entry))
      },
    }
    const factory = opts.driverFactory ?? defaultDriverFactory
    const driver = await factory({
      headless: opts.headless,
      userDataDir: opts.userDataDir,
      connectUrl: opts.connectUrl,
      events,
    })
    self = new BrowserDebugSession(driver, opts.headless, mode, {
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

// ── Process-level singleton ────────────────────────────────────────────────

let current: BrowserDebugSession | null = null
let opening: Promise<BrowserDebugSession> | null = null
let exitHookInstalled = false

function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  const cleanup = () => {
    const s = current
    current = null
    if (s) void s.close().catch(() => {})
  }
  process.once('exit', cleanup)
  process.once('SIGINT', cleanup)
  process.once('SIGTERM', cleanup)
}

/**
 * Return the live session, launching one on first use. Concurrent callers share
 * the same in-flight launch.
 */
export async function getOrCreateSession(opts: {
  headless: boolean
  userDataDir: string
  connectUrl?: string
  driverFactory?: BrowserDebugDriverFactory
}): Promise<BrowserDebugSession> {
  if (current) return current
  if (opening) return opening
  installExitHook()
  opening = BrowserDebugSession.open({
    headless: opts.headless,
    userDataDir: opts.userDataDir,
    connectUrl: opts.connectUrl,
    driverFactory: opts.driverFactory,
  })
    .then((s) => {
      current = s
      opening = null
      return s
    })
    .catch((err) => {
      opening = null
      throw err
    })
  return opening
}

/** The current session, or null if none is open. */
export function getSession(): BrowserDebugSession | null {
  return current
}

/** Close and clear the singleton. Idempotent. */
export async function closeSession(): Promise<void> {
  const s = current
  current = null
  opening = null
  if (s) await s.close()
}

/** Test hook: drop the singleton without touching a real browser. */
export function __resetSessionForTest(): void {
  current = null
  opening = null
}
