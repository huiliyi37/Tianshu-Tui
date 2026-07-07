/**
 * Chrome lifecycle for the CDP backend — discovery, dedicated-profile launch,
 * endpoint attach priority, session-level singleton.
 *
 * Attach priority (first healthy endpoint wins):
 *   1. `RIVET_CU_CDP_URL` — explicit user-provided DevTools endpoint (opt-in config)
 *   2. dedicated automation profile's `DevToolsActivePort` file
 *   3. (only when the caller allows launching) spawn a dedicated instance
 *
 * A user Chrome running with `--remote-debugging-port` (e.g. :9222) is NEVER
 * auto-attached: a CDP session over the user's own profile means cookies,
 * logged-in sessions and page JS — that takeover must go through the explicit
 * `browser_adopt` action, which carries an unconditional approval gate.
 *
 * The dedicated instance runs a SEPARATE profile (`~/.rivet/chrome-automation`)
 * with `--remote-debugging-port=0` — Chrome picks a free port and writes it to
 * `<profile>/DevToolsActivePort`. The window is VISIBLE by design (this is
 * computer use; the user watches the agent work). Login state persists in the
 * profile across sessions: sign in once, stays signed in. We never kill the
 * browser on exit — the user may keep using it.
 *
 * Chrome 136+ refuses `--remote-debugging-port` on the DEFAULT profile, which
 * is exactly why the dedicated profile is the default path; adopting a user's
 * own Chrome requires them to start it with a debug port (browser_adopt).
 */

import { spawn as nodeSpawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readFile, rm, mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { rivetHome } from '../../../config/paths.js'
import { probeEndpoint, type FetchLike } from './client.js'

export interface ChromeEndpoint {
  /** DevTools HTTP base, e.g. `http://127.0.0.1:53712`. */
  httpBase: string
  /** Where the endpoint came from (routing/telemetry + user messaging). */
  source: 'env' | 'dedicated' | 'launched' | 'adopted'
}

/** Injectable process/fs surface — tests fake all of it. */
export interface ChromeDeps {
  platform?: NodeJS.Platform
  env?: Record<string, string | undefined>
  fetchImpl?: FetchLike
  spawn?: typeof nodeSpawn
  existsSyncImpl?: (p: string) => boolean
  readFileImpl?: (p: string, enc: 'utf8') => Promise<string>
  sleep?: (ms: number) => Promise<void>
  /** Profile dir override (tests use a temp dir). */
  profileDir?: string
}

const LAUNCH_WAIT_MS = 20_000
const LAUNCH_POLL_MS = 250

/** Dedicated automation profile directory. */
export function automationProfileDir(): string {
  return join(rivetHome(), 'chrome-automation')
}

/** Chrome-family binary candidates per platform, preference order. */
export function chromeBinaryCandidates(platform: NodeJS.Platform, env: Record<string, string | undefined>): string[] {
  if (platform === 'darwin') {
    return [
      '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
      `${env.HOME ?? ''}/Applications/Google Chrome.app/Contents/MacOS/Google Chrome`,
      '/Applications/Chromium.app/Contents/MacOS/Chromium',
      '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge',
      '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
    ]
  }
  if (platform === 'win32') {
    const programFiles = env['PROGRAMFILES'] ?? 'C:\\Program Files'
    const programFilesX86 = env['PROGRAMFILES(X86)'] ?? 'C:\\Program Files (x86)'
    const localAppData = env.LOCALAPPDATA ?? ''
    return [
      join(programFiles, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      join(programFilesX86, 'Google', 'Chrome', 'Application', 'chrome.exe'),
      localAppData ? join(localAppData, 'Google', 'Chrome', 'Application', 'chrome.exe') : '',
      join(programFiles, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
      join(programFilesX86, 'Microsoft', 'Edge', 'Application', 'msedge.exe'),
    ].filter(Boolean)
  }
  // Linux (not officially enabled this round, but discovery is harmless).
  return ['/usr/bin/google-chrome', '/usr/bin/chromium', '/usr/bin/chromium-browser', '/usr/bin/microsoft-edge']
}

/** First existing Chrome-family binary, or null. */
export function findChromeBinary(deps: ChromeDeps = {}): string | null {
  const platform = deps.platform ?? process.platform
  const env = deps.env ?? process.env
  const exists = deps.existsSyncImpl ?? existsSync
  for (const candidate of chromeBinaryCandidates(platform, env)) {
    if (candidate && exists(candidate)) return candidate
  }
  return null
}

/** Normalize an endpoint string to an http base (accepts host:port or URL). */
export function normalizeHttpBase(raw: string): string {
  const trimmed = raw.trim().replace(/\/+$/, '')
  if (/^https?:\/\//i.test(trimmed)) return trimmed
  if (/^wss?:\/\//i.test(trimmed)) {
    // ws://host:port/devtools/browser/… → http://host:port
    const m = trimmed.match(/^wss?:\/\/([^/]+)/i)
    return m ? `http://${m[1]}` : trimmed
  }
  return `http://${trimmed}`
}

/** Read the dedicated profile's DevToolsActivePort → http base, or null. */
async function dedicatedProfileBase(deps: ChromeDeps): Promise<string | null> {
  const profileDir = deps.profileDir ?? automationProfileDir()
  const portFile = join(profileDir, 'DevToolsActivePort')
  const exists = deps.existsSyncImpl ?? existsSync
  if (!exists(portFile)) return null
  try {
    const read = deps.readFileImpl ?? ((p: string, enc: 'utf8') => readFile(p, enc))
    const content = await read(portFile, 'utf8')
    const firstLine = content.split('\n')[0]?.trim() ?? ''
    const port = Number.parseInt(firstLine, 10)
    if (!Number.isInteger(port) || port <= 0) return null
    return `http://127.0.0.1:${port}`
  } catch {
    return null
  }
}

/**
 * Try to attach to an already-running endpoint WITHOUT launching anything.
 * Returns null when nothing answers.
 */
export async function attachEndpoint(deps: ChromeDeps = {}): Promise<ChromeEndpoint | null> {
  const env = deps.env ?? process.env
  const fetchImpl = deps.fetchImpl ?? fetch

  const explicit = env.RIVET_CU_CDP_URL
  if (explicit && explicit.trim()) {
    const base = normalizeHttpBase(explicit)
    if (await probeEndpoint(base, fetchImpl)) return { httpBase: base, source: 'env' }
    // Explicit endpoint configured but dead: fall through to other sources
    // (fail-open here would mask typos; but a dead env endpoint should not
    // brick the dedicated-profile path either).
  }

  const dedicated = await dedicatedProfileBase(deps)
  if (dedicated && (await probeEndpoint(dedicated, fetchImpl))) {
    return { httpBase: dedicated, source: 'dedicated' }
  }

  // Deliberately NO `localhost:9222` probe here — attaching to a user-launched
  // debug-port Chrome grabs their logged-in profile without consent. That path
  // exists only as the explicit `browser_adopt` action (unconditional approval).
  return null
}

/**
 * Launch a dedicated automation-profile Chrome and wait for its
 * DevToolsActivePort file. Visible window, free debug port.
 */
export async function launchDedicated(deps: ChromeDeps = {}): Promise<ChromeEndpoint> {
  const binary = findChromeBinary(deps)
  if (!binary) {
    throw new Error('no Chrome-family browser found (looked for Chrome, Chromium, Edge in standard locations)')
  }
  const profileDir = deps.profileDir ?? automationProfileDir()
  const spawnImpl = deps.spawn ?? nodeSpawn
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)))
  const fetchImpl = deps.fetchImpl ?? fetch

  await mkdir(profileDir, { recursive: true })
  // Stale port file from a previous run would race the "wait for file" loop.
  await rm(join(profileDir, 'DevToolsActivePort'), { force: true })

  const child = spawnImpl(
    binary,
    [
      '--remote-debugging-port=0',
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=ChromeWhatsNewUI',
      'about:blank',
    ],
    { detached: true, stdio: 'ignore' },
  )
  child.unref()

  const deadline = Date.now() + LAUNCH_WAIT_MS
  for (;;) {
    const base = await dedicatedProfileBase(deps)
    if (base && (await probeEndpoint(base, fetchImpl))) {
      return { httpBase: base, source: 'launched' }
    }
    if (Date.now() >= deadline) {
      throw new Error(`Chrome launched but DevTools endpoint did not come up within ${LAUNCH_WAIT_MS}ms (profile: ${profileDir})`)
    }
    await sleep(LAUNCH_POLL_MS)
  }
}

// --- session-level singleton ---

let cachedEndpoint: ChromeEndpoint | null = null
let lastVerifiedAt = 0

/** Re-probe cached endpoints no more often than this (ms). */
const ENDPOINT_VERIFY_TTL_MS = 5_000

/**
 * Session-level endpoint accessor. Attaches (never launches) unless
 * `allowLaunch` — snapshot/click on an already-running browser must not
 * surprise-spawn windows; launch_app/navigate/browser-specific actions may.
 */
export async function ensureEndpoint(opts: { allowLaunch: boolean }, deps: ChromeDeps = {}): Promise<ChromeEndpoint | null> {
  const fetchImpl = deps.fetchImpl ?? fetch
  if (cachedEndpoint) {
    if (Date.now() - lastVerifiedAt < ENDPOINT_VERIFY_TTL_MS) return cachedEndpoint
    if (await probeEndpoint(cachedEndpoint.httpBase, fetchImpl)) {
      lastVerifiedAt = Date.now()
      return cachedEndpoint
    }
    cachedEndpoint = null
  }
  const attached = await attachEndpoint(deps)
  if (attached) {
    cachedEndpoint = attached
    lastVerifiedAt = Date.now()
    return attached
  }
  if (!opts.allowLaunch) return null
  const launched = await launchDedicated(deps)
  cachedEndpoint = launched
  lastVerifiedAt = Date.now()
  return launched
}

/** Explicit takeover of a user-provided endpoint (browser_adopt action). */
export async function adoptEndpoint(raw: string, deps: ChromeDeps = {}): Promise<ChromeEndpoint> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const base = normalizeHttpBase(raw)
  if (!(await probeEndpoint(base, fetchImpl))) {
    throw new Error(`no DevTools endpoint answering at ${base} — start Chrome with --remote-debugging-port=9222 (a fresh profile via --user-data-dir is required on Chrome 136+)`)
  }
  cachedEndpoint = { httpBase: base, source: 'adopted' }
  lastVerifiedAt = Date.now()
  return cachedEndpoint
}

/** Current cached endpoint without probing (may be stale). */
export function currentEndpoint(): ChromeEndpoint | null {
  return cachedEndpoint
}

/** Test hook: clear the singleton. */
export function resetEndpointForTests(): void {
  cachedEndpoint = null
  lastVerifiedAt = 0
}
