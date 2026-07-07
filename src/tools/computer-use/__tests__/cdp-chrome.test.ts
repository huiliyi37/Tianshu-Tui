import { test, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { mkdtempSync } from 'node:fs'
import type { FetchLike } from '../cdp/client.js'
import {
  adoptEndpoint,
  attachEndpoint,
  chromeBinaryCandidates,
  ensureEndpoint,
  findChromeBinary,
  launchDedicated,
  normalizeHttpBase,
  resetEndpointForTests,
  type ChromeDeps,
} from '../cdp/chrome.js'

beforeEach(() => resetEndpointForTests())

/** fetch that answers /json/version only for the given http bases. */
function probeFetch(aliveBases: string[]): FetchLike {
  return async (url) => {
    const alive = aliveBases.some((b) => url.startsWith(`${b}/`))
    if (!alive) throw new Error('ECONNREFUSED')
    return {
      ok: true,
      status: 200,
      json: async () => ({ webSocketDebuggerUrl: 'ws://x/devtools/browser/1', Browser: 'Chrome/140' }),
      text: async () => '',
    }
  }
}

// ── binary discovery ────────────────────────────────────────────────

test('chrome binary candidates: darwin prefers /Applications Chrome, win32 Program Files', () => {
  const mac = chromeBinaryCandidates('darwin', { HOME: '/Users/u' })
  assert.equal(mac[0], '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome')
  assert.ok(mac.some((c) => c.includes('Microsoft Edge')))
  const win = chromeBinaryCandidates('win32', { PROGRAMFILES: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' })
  assert.ok(win[0]!.endsWith(join('Google', 'Chrome', 'Application', 'chrome.exe')))
  assert.ok(win.some((c) => c.includes('msedge.exe')))
})

test('findChromeBinary: first existing candidate wins; none → null', () => {
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  const deps: ChromeDeps = { platform: 'darwin', env: {}, existsSyncImpl: (p) => p === edge }
  assert.equal(findChromeBinary(deps), edge)
  assert.equal(findChromeBinary({ platform: 'darwin', env: {}, existsSyncImpl: () => false }), null)
})

// ── endpoint normalization ──────────────────────────────────────────

test('normalizeHttpBase: host:port, http URL, ws URL all become http bases', () => {
  assert.equal(normalizeHttpBase('localhost:9222'), 'http://localhost:9222')
  assert.equal(normalizeHttpBase('http://127.0.0.1:9222/'), 'http://127.0.0.1:9222')
  assert.equal(normalizeHttpBase('ws://127.0.0.1:9333/devtools/browser/abc'), 'http://127.0.0.1:9333')
})

// ── attach priority ─────────────────────────────────────────────────

test('attachEndpoint: RIVET_CU_CDP_URL wins when alive', async () => {
  const deps: ChromeDeps = {
    env: { RIVET_CU_CDP_URL: 'localhost:9500' },
    fetchImpl: probeFetch(['http://localhost:9500']),
    existsSyncImpl: () => false,
  }
  const ep = await attachEndpoint(deps)
  assert.deepEqual(ep, { httpBase: 'http://localhost:9500', source: 'env' })
})

test('attachEndpoint: dedicated profile DevToolsActivePort is second priority', async () => {
  const profileDir = '/fake/profile'
  const portFile = join(profileDir, 'DevToolsActivePort')
  const deps: ChromeDeps = {
    env: {},
    profileDir,
    existsSyncImpl: (p) => p === portFile,
    readFileImpl: async () => '9333\n/devtools/browser/abc',
    fetchImpl: probeFetch(['http://127.0.0.1:9333']),
  }
  const ep = await attachEndpoint(deps)
  assert.deepEqual(ep, { httpBase: 'http://127.0.0.1:9333', source: 'dedicated' })
})

test('attachEndpoint: a live localhost:9222 is NEVER auto-attached (user Chrome needs browser_adopt)', async () => {
  // Security invariant: a user Chrome running with --remote-debugging-port
  // carries their logged-in profile. Even with :9222 answering, the default
  // attach path must return null — takeover only via the explicit
  // browser_adopt action (unconditional approval).
  const base: ChromeDeps = { env: {}, existsSyncImpl: () => false }
  assert.equal(await attachEndpoint({ ...base, fetchImpl: probeFetch(['http://127.0.0.1:9222']) }), null)
  assert.equal(await attachEndpoint({ ...base, fetchImpl: probeFetch([]) }), null)
})

test('attachEndpoint: dead RIVET_CU_CDP_URL falls through, but never to a live :9222', async () => {
  const deps: ChromeDeps = {
    env: { RIVET_CU_CDP_URL: 'localhost:1' },
    existsSyncImpl: () => false,
    fetchImpl: probeFetch(['http://127.0.0.1:9222']),
  }
  assert.equal(await attachEndpoint(deps), null)
})

// ── dedicated launch ────────────────────────────────────────────────

test('launchDedicated: spawns visible Chrome with dedicated profile and free port, reads DevToolsActivePort', async () => {
  const profileDir = mkdtempSync(join(tmpdir(), 'rivet-cdp-test-'))
  const portFile = join(profileDir, 'DevToolsActivePort')
  const spawned: Array<{ bin: string; args: string[] }> = []
  let portFileWritten = false
  const deps: ChromeDeps = {
    platform: 'darwin',
    env: {},
    profileDir,
    existsSyncImpl: (p) => {
      if (p === '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome') return true
      if (p === portFile) return portFileWritten
      return false
    },
    readFileImpl: async () => '9444\n/devtools/browser/xyz',
    fetchImpl: probeFetch(['http://127.0.0.1:9444']),
    spawn: ((bin: string, args: string[]) => {
      spawned.push({ bin, args })
      // Simulate Chrome writing the port file shortly after spawn.
      portFileWritten = true
      return { unref() { /* detached */ } }
    }) as never,
    sleep: async () => {},
  }
  const ep = await launchDedicated(deps)
  assert.deepEqual(ep, { httpBase: 'http://127.0.0.1:9444', source: 'launched' })
  assert.equal(spawned.length, 1)
  const args = spawned[0]!.args
  assert.ok(args.includes('--remote-debugging-port=0'), 'must ask Chrome for a FREE port')
  assert.ok(args.includes(`--user-data-dir=${profileDir}`), 'must isolate into the automation profile')
  assert.ok(args.includes('--no-first-run'))
  assert.ok(!args.some((a) => a.includes('--headless')), 'computer use is VISIBLE by design')
})

test('launchDedicated: no browser installed → clear error', async () => {
  const deps: ChromeDeps = {
    platform: 'darwin',
    env: {},
    profileDir: mkdtempSync(join(tmpdir(), 'rivet-cdp-test-')),
    existsSyncImpl: () => false,
  }
  await assert.rejects(launchDedicated(deps), /no Chrome-family browser found/)
})

// ── session singleton ───────────────────────────────────────────────

test('ensureEndpoint: attach-only when allowLaunch=false; caches the verdict', async () => {
  let probes = 0
  const counting: FetchLike = async (url) => {
    probes++
    return probeFetch(['http://localhost:9500'])(url)
  }
  const deps: ChromeDeps = {
    env: { RIVET_CU_CDP_URL: 'localhost:9500' },
    existsSyncImpl: () => false,
    fetchImpl: counting,
  }
  const ep1 = await ensureEndpoint({ allowLaunch: false }, deps)
  assert.equal(ep1?.source, 'env')
  const probesAfterFirst = probes
  // Within the verify TTL the cached endpoint is reused without re-probing.
  const ep2 = await ensureEndpoint({ allowLaunch: false }, deps)
  assert.equal(ep2?.httpBase, ep1?.httpBase)
  assert.equal(probes, probesAfterFirst)
})

test('ensureEndpoint: nothing attachable and allowLaunch=false → null (no surprise windows)', async () => {
  const deps: ChromeDeps = { env: {}, existsSyncImpl: () => false, fetchImpl: probeFetch([]) }
  assert.equal(await ensureEndpoint({ allowLaunch: false }, deps), null)
})

// ── adopt ───────────────────────────────────────────────────────────

test('adoptEndpoint: healthy endpoint is adopted and cached; dead endpoint gives guidance', async () => {
  const deps: ChromeDeps = { env: {}, fetchImpl: probeFetch(['http://127.0.0.1:9666']) }
  const ep = await adoptEndpoint('127.0.0.1:9666', deps)
  assert.deepEqual(ep, { httpBase: 'http://127.0.0.1:9666', source: 'adopted' })
  await assert.rejects(
    adoptEndpoint('127.0.0.1:1', { env: {}, fetchImpl: probeFetch([]) }),
    /no DevTools endpoint answering at http:\/\/127\.0\.0\.1:1 — start Chrome with --remote-debugging-port=9222/,
  )
})
