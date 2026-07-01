/**
 * browser_debug — persistent browser for local frontend/backend联调 (CDP route).
 *
 * Opens a persistent-profile browser (headed by default), navigates to a URL,
 * and exposes the live console + network log for debugging. Login pages pause
 * the turn (`await_login`) so the user can sign in by hand, after which the
 * saved profile carries the session into later actions.
 *
 * Connection modes:
 *  - **launch** (default) — Rivet starts a headed Chromium with a profile under
 *    ~/.rivet/browser-debug-profile (login survives Rivet restarts);
 *  - **connect** — attach to your existing Chrome via CDP. Pass connect_url on
 *    `open`, or set RIVET_BROWSER_URL=http://127.0.0.1:9222. Start Chrome with:
 *    `google-chrome --remote-debugging-port=9222`. close() disconnects only.
 *
 * Security posture:
 *  - loopback page hosts always allowed, no approval;
 *  - loopback CDP endpoints always allowed;
 *  - other hosts/endpoints need RIVET_BROWSER_ALLOWLIST + approval.
 */

import { join } from 'node:path'
import type { Tool, ToolCallParams, ToolResult } from '../types.js'
import { rivetHome } from '../../config/paths.js'
import { isHostAllowed } from '../browser.js'
import {
  getOrCreateSession,
  getSession,
  closeSession,
  type BrowserDebugSession,
} from './session.js'
import { formatConsoleLine, formatNetworkLine, type ConsoleLevel } from './log-capture.js'
import type { BrowserDebugDriverFactory } from './driver.js'

export interface BrowserDebugToolOptions {
  driverFactory?: BrowserDebugDriverFactory
  /** Extra allowed hosts (beyond loopback). Empty ⇒ only loopback is reachable. */
  allowlist?: () => string[]
  /** Persistent profile directory. Defaults to ~/.rivet/browser-debug-profile. */
  userDataDir?: () => string
  enabled?: boolean
}

const NAV_ACTIONS = new Set(['open', 'navigate'])
const CONSOLE_TAIL = 100
const NETWORK_TAIL = 100
const SNAPSHOT_MAX = 20_000

function envAllowlist(): string[] {
  return (process.env.RIVET_BROWSER_ALLOWLIST ?? '')
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
}

function defaultUserDataDir(): string {
  return join(rivetHome(), 'browser-debug-profile')
}

/** Loopback hosts are always reachable — localhost联调 is the core use case. */
export function isLoopbackHost(host: string): boolean {
  const h = host.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost')
}

/** Combined gate: loopback OR explicitly allowlisted. */
export function isDebugHostAllowed(host: string, allowlist: string[]): boolean {
  return isLoopbackHost(host) || isHostAllowed(host, allowlist)
}

/** CDP connect URLs must be http:// to a loopback host (fail-closed). */
export function isLoopbackCdpUrl(raw: string): boolean {
  try {
    const u = new URL(raw)
    return u.protocol === 'http:' && isLoopbackHost(u.hostname)
  } catch {
    return false
  }
}

export function isCdpUrlAllowed(raw: string, allowlist: string[]): boolean {
  try {
    const u = new URL(raw)
    if (u.protocol !== 'http:') return false
    return isLoopbackHost(u.hostname) || isHostAllowed(u.hostname, allowlist)
  } catch {
    return false
  }
}

type BrowserDebugAction =
  | 'open'
  | 'navigate'
  | 'console'
  | 'network'
  | 'eval'
  | 'screenshot'
  | 'snapshot'
  | 'click'
  | 'type'
  | 'wait'
  | 'await_login'
  | 'status'
  | 'clear_logs'
  | 'close'

function parseNavUrl(raw: string): { url: URL } | { error: string } {
  let url: URL
  try {
    url = new URL(raw)
  } catch {
    return { error: `Invalid URL: ${raw}` }
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { error: `Unsupported protocol: ${url.protocol}. Only http/https allowed.` }
  }
  return { url }
}

function resolveConnectUrl(input: Record<string, unknown>, action: string): string | undefined {
  const explicit = input.connect_url
  if (typeof explicit === 'string' && explicit.trim()) return explicit.trim()
  if (action === 'open' && process.env.RIVET_BROWSER_URL?.trim()) {
    return process.env.RIVET_BROWSER_URL.trim()
  }
  return undefined
}

/** Wire onOutput for the duration of an action that may emit console/network. */
async function withLiveLogs<T>(
  session: BrowserDebugSession,
  onOutput: ToolCallParams['onOutput'],
  fn: () => Promise<T>,
): Promise<T> {
  session.setOutputSink(onOutput ?? null)
  try {
    return await fn()
  } finally {
    session.setOutputSink(null)
  }
}

function formatStatus(session: BrowserDebugSession): string {
  const net = session.log.getNetwork()
  const failed = session.log.getNetwork(true).length
  const consoleTotal = session.log.getConsole().length
  const errCount = session.log.getConsole('error').length
  const lines = [
    `mode: ${session.mode}${session.connectUrl ? ` (${session.connectUrl})` : ''}`,
    `headless: ${session.headless}`,
    `url: ${session.driver.currentUrl()}`,
    `console: ${consoleTotal} message(s) (${errCount} error(s))`,
    `network: ${net.length} request(s) (${failed} failed/4xx/5xx)`,
  ]
  if (session.userDataDir) lines.push(`profile: ${session.userDataDir}`)
  if (session.mode === 'connect') {
    lines.push('note: close disconnects from Chrome without quitting it')
  }
  return lines.join('\n')
}

export function createBrowserDebugTool(options: BrowserDebugToolOptions = {}): Tool {
  const driverFactory = options.driverFactory
  const allowlist = options.allowlist ?? envAllowlist
  const userDataDir = options.userDataDir ?? defaultUserDataDir
  const enabled = options.enabled ?? false

  async function ensureSession(headless: boolean, connectUrl?: string): Promise<BrowserDebugSession> {
    return getOrCreateSession({
      headless,
      userDataDir: userDataDir(),
      connectUrl,
      driverFactory,
    })
  }

  return {
    definition: {
      name: 'browser_debug',
      description: `Drive a persistent browser to debug local web apps (frontend + backend API联调) over the Chrome DevTools Protocol.

Connection:
- Default: Rivet launches a headed Chromium; login state persists in ~/.rivet/browser-debug-profile.
- Connect to existing Chrome: pass connect_url on open (or set RIVET_BROWSER_URL). Start Chrome with \`--remote-debugging-port=9222\`. close() disconnects only — it does not quit your browser.

Actions:
- open / navigate {url}: open or navigate. localhost/127.0.0.1 always allowed; other hosts need allowlist + approval.
- console {level?}: read captured console messages (log|info|warn|error|debug).
- network {failed_only?}: read network requests (method/status/timing). failed_only keeps failures and 4xx/5xx.
- snapshot {selector?}: read visible page text (or a CSS selector subtree).
- eval {expression}: run JavaScript in the page and return the result.
- screenshot: full-page PNG saved as artifact.
- click {selector} / type {selector, text}: interact with the page.
- wait {selector, timeout_ms?}: wait until an element is visible (default 10s).
- status: session summary (mode, url, log counts).
- clear_logs: wipe captured console + network buffers.
- await_login {message?}: pause the turn for manual login/CAPTCHA; reply to continue.
- close: close the session (launch mode quits browser; connect mode disconnects only).

Console and network events stream live during navigate/click/type/wait/eval.`,
      input_schema: {
        type: 'object',
        properties: {
          action: {
            type: 'string',
            enum: [
              'open', 'navigate', 'console', 'network', 'eval', 'screenshot', 'snapshot',
              'click', 'type', 'wait', 'await_login', 'status', 'clear_logs', 'close',
            ],
            description: 'What to do.',
          },
          url: { type: 'string', description: 'URL for open/navigate.' },
          connect_url: {
            type: 'string',
            description: 'CDP endpoint for open, e.g. http://127.0.0.1:9222. Falls back to RIVET_BROWSER_URL on open.',
          },
          selector: { type: 'string', description: 'CSS selector for click/type/wait/snapshot.' },
          text: { type: 'string', description: 'Text to fill for type.' },
          expression: { type: 'string', description: 'JavaScript expression for eval.' },
          level: { type: 'string', enum: ['log', 'info', 'warn', 'error', 'debug'], description: 'Console level filter.' },
          failed_only: { type: 'boolean', description: 'network: only failures and 4xx/5xx.' },
          headless: { type: 'boolean', description: 'Launch hidden (default false — headed for manual login).' },
          timeout_ms: { type: 'integer', description: 'wait: timeout in ms (default 10000).' },
          message: { type: 'string', description: 'await_login: prompt shown to the user.' },
        },
        required: ['action'],
      },
    },

    async execute(params: ToolCallParams): Promise<ToolResult> {
      const action = params.input.action as BrowserDebugAction
      const headless = params.input.headless === true
      const connectUrl = resolveConnectUrl(params.input, action)

      // ── close ──────────────────────────────────────────────────────────
      if (action === 'close') {
        const session = getSession()
        if (!session) return { content: 'No browser session was open.' }
        const mode = session.mode
        await closeSession()
        return {
          content: mode === 'connect'
            ? 'Disconnected from Chrome (browser left running).'
            : 'Browser session closed.',
        }
      }

      // ── status ─────────────────────────────────────────────────────────
      if (action === 'status') {
        const session = getSession()
        if (!session) return { content: 'No browser session open.', isError: true }
        return { content: formatStatus(session) }
      }

      // ── await_login (endTurn) ──────────────────────────────────────────
      if (action === 'await_login') {
        if (connectUrl && !isCdpUrlAllowed(connectUrl, allowlist())) {
          return {
            content: `browser_debug blocked: CDP endpoint "${connectUrl}" is not loopback and not allowlisted.`,
            isError: true,
          }
        }
        try {
          const session = await ensureSession(headless, connectUrl)
          if (!headless) await session.driver.bringToFront().catch(() => {})
        } catch (err) {
          return { content: `browser_debug failed to open: ${(err as Error).message}`, isError: true }
        }
        const msg =
          (typeof params.input.message === 'string' && params.input.message.trim()) ||
          'Complete login / manual steps in the browser window, then reply to continue.'
        return {
          content: '[Awaiting manual login — the user will reply once done.]',
          uiContent: `${msg}\n\n(The persistent profile keeps your session for later browser_debug actions.)`,
          endTurn: true,
        }
      }

      // ── navigation actions ─────────────────────────────────────────────
      if (NAV_ACTIONS.has(action)) {
        const rawUrl = params.input.url as string | undefined
        if (!rawUrl) return { content: `${action} requires a "url".`, isError: true }
        const parsed = parseNavUrl(rawUrl)
        if ('error' in parsed) return { content: parsed.error, isError: true }

        const list = allowlist()
        if (!isDebugHostAllowed(parsed.url.hostname, list)) {
          return {
            content:
              `browser_debug blocked: host "${parsed.url.hostname}" is not loopback and not on the allowlist (fail-closed). ` +
              (list.length === 0
                ? 'Only localhost is reachable — set RIVET_BROWSER_ALLOWLIST for other hosts.'
                : `Allowed: ${list.join(', ')}.`),
            isError: true,
          }
        }
        if (connectUrl && !isCdpUrlAllowed(connectUrl, list)) {
          return {
            content: `browser_debug blocked: CDP endpoint "${connectUrl}" is not loopback and not allowlisted.`,
            isError: true,
          }
        }

        try {
          const session = await ensureSession(headless, connectUrl)
          await withLiveLogs(session, params.onOutput, () => session.driver.goto(rawUrl))
          const finalUrl = session.driver.currentUrl()
          const netCount = session.log.getNetwork().length
          const errCount = session.log.getConsole('error').length
          const modeHint = session.mode === 'connect' ? ' (connected via CDP)' : ''
          return {
            content:
              `Navigated to ${finalUrl}${modeHint}. Captured ${netCount} network request(s), ${errCount} console error(s). ` +
              `Use action="console" / action="network" / action="status" to inspect.`,
          }
        } catch (err) {
          return { content: `browser_debug navigation failed: ${(err as Error).message}`, isError: true }
        }
      }

      // ── all remaining actions need a live session ────────────────────
      const session = getSession()
      if (!session) {
        return { content: 'No browser session open. Use action="open" with a url first.', isError: true }
      }

      try {
        switch (action) {
          case 'console': {
            const level = params.input.level as ConsoleLevel | undefined
            const entries = session.log.getConsole(level).slice(-CONSOLE_TAIL)
            if (entries.length === 0) return { content: '(no console output)' }
            return { content: entries.map(formatConsoleLine).join('\n') }
          }
          case 'network': {
            const failedOnly = params.input.failed_only === true
            const entries = session.log.getNetwork(failedOnly).slice(-NETWORK_TAIL)
            if (entries.length === 0) {
              return { content: failedOnly ? '(no failed requests)' : '(no network activity)' }
            }
            return { content: entries.map(formatNetworkLine).join('\n') }
          }
          case 'clear_logs': {
            session.log.clear()
            return { content: 'Console and network logs cleared.' }
          }
          case 'snapshot': {
            const selector = params.input.selector as string | undefined
            const text = await withLiveLogs(session, params.onOutput, () => session.driver.snapshot(selector))
            const trimmed = text.slice(0, SNAPSHOT_MAX)
            return {
              content: trimmed + (text.length > SNAPSHOT_MAX ? '\n… (truncated)' : ''),
              lossiness: text.length > SNAPSHOT_MAX ? 'truncated' : undefined,
            }
          }
          case 'eval': {
            const expression = params.input.expression as string | undefined
            if (!expression) return { content: 'eval requires an "expression".', isError: true }
            const result = await withLiveLogs(session, params.onOutput, () =>
              session.driver.evaluate(expression),
            )
            return { content: result.slice(0, SNAPSHOT_MAX) }
          }
          case 'click': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'click requires a "selector".', isError: true }
            await withLiveLogs(session, params.onOutput, () => session.driver.click(selector))
            return { content: `Clicked ${selector}.` }
          }
          case 'type': {
            const selector = params.input.selector as string | undefined
            const text = params.input.text as string | undefined
            if (!selector || text === undefined) {
              return { content: 'type requires "selector" and "text".', isError: true }
            }
            await withLiveLogs(session, params.onOutput, () => session.driver.type(selector, text))
            return { content: `Typed into ${selector}.` }
          }
          case 'wait': {
            const selector = params.input.selector as string | undefined
            if (!selector) return { content: 'wait requires a "selector".', isError: true }
            const timeoutMs =
              typeof params.input.timeout_ms === 'number' && params.input.timeout_ms > 0
                ? params.input.timeout_ms
                : 10_000
            await withLiveLogs(session, params.onOutput, () =>
              session.driver.waitForSelector(selector, timeoutMs),
            )
            return { content: `Element "${selector}" is visible (${timeoutMs}ms timeout).` }
          }
          case 'screenshot': {
            const png = await session.driver.screenshot()
            const base64 = png.toString('base64')
            let artifactId: string | undefined
            if (params.artifactStore) {
              const host = (() => {
                try {
                  return new URL(session.driver.currentUrl()).hostname
                } catch {
                  return 'page'
                }
              })()
              artifactId = await params.artifactStore.save({
                tool: 'browser_screenshot',
                target: `${host}-screenshot.png`,
                rawContent: base64,
                summary: `Screenshot of ${session.driver.currentUrl()}`,
                sections: [],
              })
            }
            return {
              content: `Captured screenshot of ${session.driver.currentUrl()}` + (artifactId ? ` → artifact ${artifactId}` : ''),
            }
          }
          default:
            return { content: `Unknown action: ${String(action)}`, isError: true }
        }
      } catch (err) {
        return { content: `browser_debug ${action} failed: ${(err as Error).message}`, isError: true }
      }
    },

    requiresApproval(params: ToolCallParams): boolean {
      const action = params.input.action as string
      const connectUrl = resolveConnectUrl(params.input, action)
      if (connectUrl) {
        try {
          if (!isLoopbackHost(new URL(connectUrl).hostname)) return true
        } catch {
          /* invalid URL handled in execute */
        }
      }
      if (!NAV_ACTIONS.has(action)) return false
      const rawUrl = params.input.url
      if (typeof rawUrl !== 'string') return false
      try {
        return !isLoopbackHost(new URL(rawUrl).hostname)
      } catch {
        return false
      }
    },

    isConcurrencySafe: () => false,
    isEnabled: () => enabled,
    timeoutMs: (params) => (params?.input.action === 'wait' ? 120_000 : 60_000),
  }
}

export const BROWSER_DEBUG_TOOL: Tool = createBrowserDebugTool({ enabled: true })
