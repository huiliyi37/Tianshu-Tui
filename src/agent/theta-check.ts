import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { gracefulKill, forceKill } from '../platform.js'
import { track } from '../tools/process-tracker.js'

export interface ThetaCheckResult {
  errors: string[]
  durationMs: number
  timedOut: boolean
}

function parseTypeScriptErrorFiles(output: string): string[] {
  const files = new Set<string>()
  for (const line of output.split('\n')) {
    if (!line.includes('error TS')) continue
    const match = line.match(/^(.+?)\(\d+,\d+\):\s+error TS\d+:/)
    if (match?.[1]) files.add(match[1])
  }
  return [...files]
}

// ── Cross-process result cache ─────────────────────────────────────
// Multiple INDEPENDENT 天枢 TUI processes (and same-process workers) share
// one repo and would otherwise each spawn a full `tsc --noEmit` (~6s).
// In-memory state cannot dedup across separate node processes, so the cache
// is backed by a file under <cwd>/.rivet/tmp/ (already gitignored) plus a
// lock file for cross-process in-flight dedup:
//   - L1: per-cwd in-memory (fast path for repeated same-process calls)
//   - L2: on-disk JSON (TTL) shared by every process on this repo
//   - lock: only the process that wins the lock spawns tsc; concurrent
//     processes reuse the last on-disk result instead of spawning again.
// theta is best-effort: a slightly stale or empty result is always preferable
// to a redundant tsc spawn or a blocked agent loop.
const CACHE_TTL_MS = 15_000
const LOCK_STALE_BUFFER_MS = 5_000

interface DiskCacheEntry {
  result: ThetaCheckResult
  cachedAt: number
}

// Per-cwd in-memory layer — keyed by cwd so a worktree worker (repoB) never
// reads the main loop's (repoA) result. Fixes cross-cwd pollution.
const memCache = new Map<string, DiskCacheEntry>()
const memInFlight = new Map<string, Promise<ThetaCheckResult>>()

function cacheDir(cwd: string): string {
  return join(cwd, '.rivet', 'tmp')
}
function cacheFile(cwd: string): string {
  return join(cacheDir(cwd), 'theta-cache.json')
}
function lockFile(cwd: string): string {
  return join(cacheDir(cwd), 'theta-cache.lock')
}

function readDiskCache(cwd: string): DiskCacheEntry | null {
  try {
    const raw = readFileSync(cacheFile(cwd), 'utf8')
    const parsed = JSON.parse(raw) as DiskCacheEntry
    if (!parsed || typeof parsed.cachedAt !== 'number' || !Array.isArray(parsed.result?.errors)) return null
    return parsed
  } catch {
    return null
  }
}

function writeDiskCache(cwd: string, entry: DiskCacheEntry): void {
  try {
    mkdirSync(cacheDir(cwd), { recursive: true })
    writeFileSync(cacheFile(cwd), JSON.stringify(entry), 'utf8')
  } catch {
    /* best-effort: degrade to in-memory only if disk unavailable */
  }
}

/** Atomically acquire the cross-process lock. Returns true if this process owns it. */
function tryAcquireLock(cwd: string, timeoutMs: number): boolean {
  const path = lockFile(cwd)
  try {
    mkdirSync(cacheDir(cwd), { recursive: true })
    // O_EXCL: fails if the lock already exists — atomic across processes.
    const fd = openSync(path, 'wx')
    writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
    closeSync(fd)
    return true
  } catch {
    // Lock exists — check if it is stale (owner crashed / hung) and steal it.
    try {
      const held = JSON.parse(readFileSync(path, 'utf8')) as { at?: number }
      const age = Date.now() - (held.at ?? 0)
      if (age > timeoutMs + LOCK_STALE_BUFFER_MS) {
        rmSync(path, { force: true })
        const fd = openSync(path, 'wx')
        writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }))
        closeSync(fd)
        return true
      }
    } catch {
      /* race on steal — let the other winner proceed */
    }
    return false
  }
}

function releaseLock(cwd: string): void {
  try { rmSync(lockFile(cwd), { force: true }) } catch { /* ignore */ }
}

/**
 * Run a lightweight theta-gamma consistency check with an isolated tsc process.
 *
 * Best-effort: missing tsc, missing tsconfig, and timeouts return an empty
 * error set so the agent loop never blocks. Cross-process dedup ensures only
 * one process per repo runs tsc within a TTL window.
 */
export function runThetaCheck(cwd: string, timeoutMs = 15_000): Promise<ThetaCheckResult> {
  // L1: fresh in-process result for this cwd
  const mem = memCache.get(cwd)
  if (mem && (Date.now() - mem.cachedAt) < CACHE_TTL_MS) {
    return Promise.resolve(mem.result)
  }
  // L1: in-flight in this process for this cwd
  const flight = memInFlight.get(cwd)
  if (flight) return flight

  const promise = resolveThetaCheck(cwd, timeoutMs).then(result => {
    memCache.set(cwd, { result, cachedAt: Date.now() })
    memInFlight.delete(cwd)
    return result
  }).catch(err => {
    memInFlight.delete(cwd)
    throw err
  })
  memInFlight.set(cwd, promise)
  return promise
}

async function resolveThetaCheck(cwd: string, timeoutMs: number): Promise<ThetaCheckResult> {
  // L2: fresh on-disk result shared across processes
  const disk = readDiskCache(cwd)
  if (disk && (Date.now() - disk.cachedAt) < CACHE_TTL_MS) {
    return disk.result
  }
  // Cross-process in-flight dedup: only the lock winner spawns tsc.
  if (!tryAcquireLock(cwd, timeoutMs)) {
    // Another process is running tsc. Best-effort: reuse the last on-disk
    // result (even if past TTL) rather than spawn a redundant tsc. If there
    // is nothing yet, return empty — theta is a soft hint, never a blocker.
    return disk?.result ?? { errors: [], durationMs: 0, timedOut: false }
  }
  try {
    const result = await runThetaCheckInner(cwd, timeoutMs)
    // Don't cache timed-out results: a transient timeout shouldn't pin a fake
    // green for the whole TTL window — let the next caller retry.
    if (!result.timedOut) writeDiskCache(cwd, { result, cachedAt: Date.now() })
    return result
  } finally {
    releaseLock(cwd)
  }
}

/** Clear caches (for testing). Pass a cwd to also remove its on-disk cache. */
export function clearThetaCache(cwd?: string): void {
  memCache.clear()
  memInFlight.clear()
  if (cwd) {
    try { rmSync(cacheFile(cwd), { force: true }) } catch { /* ignore */ }
    try { rmSync(lockFile(cwd), { force: true }) } catch { /* ignore */ }
  }
}

function runThetaCheckInner(cwd: string, timeoutMs: number): Promise<ThetaCheckResult> {
  const start = Date.now()

  return new Promise(resolve => {
    const child = track(spawn('npx', ['tsc', '--noEmit', '--skipLibCheck'], {
      cwd,
      env: { ...process.env },
      stdio: ['ignore', 'pipe', 'pipe'],
    }))

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (errors: string[], didTimeOut = timedOut): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ errors, durationMs: Date.now() - start, timedOut: didTimeOut })
    }

    const timer = setTimeout(() => {
      timedOut = true
      gracefulKill(child)
      setTimeout(() => forceKill(child), 3000)
      finish([])
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      if (stdout.length > 100_000) stdout = stdout.slice(-80_000)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 100_000) stderr = stderr.slice(-80_000)
    })

    child.on('close', (code) => {
      if (timedOut) return
      if (code === 0) {
        finish([])
        return
      }
      finish(parseTypeScriptErrorFiles(`${stdout}\n${stderr}`))
    })

    child.on('error', () => {
      finish([])
    })
  })
}
