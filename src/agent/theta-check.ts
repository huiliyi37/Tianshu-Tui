import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, openSync, closeSync, readFileSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { gracefulKill, forceKill } from '../platform.js'
import { track } from '../tools/process-tracker.js'
import { resolveNpmCliCommand, buildStdioEnvWithNodePath } from '../platform/resolve-node-cli.js'

const require = createRequire(import.meta.url)

/** Theta 尝试的诚实归因——每个返回值都说得清「这次到底发生了什么」。
 *  - ok: tsc 正常退出 0，无类型错误
 *  - type_errors: tsc 非零退出（有类型错误；errors 可能因解析不到文件而为空）
 *  - timeout: 内层预算超时（唯一推进连续超时退避的结局）
 *  - spawn_error: tsc 进程 spawn 失败（ENOENT/EACCES）——不再是 timeout 的伪装
 *  - busy: 跨进程锁被占且无可用结果——不再伪装成「空错误且非超时」的假绿
 *  - backoff: 负缓存窗口内（60s 内刚 timeout/spawn_error）——不重复 spawn */
export type ThetaOutcome = 'ok' | 'type_errors' | 'timeout' | 'spawn_error' | 'busy' | 'backoff'

export interface ThetaCheckResult {
  errors: string[]
  durationMs: number
  /** 兼容字段——等价于 outcome === 'timeout'。旧消费者（theta-hook 等）不迁移。 */
  timedOut: boolean
  outcome: ThetaOutcome
}

/** outcome 推断（旧格式缓存无 outcome 字段时的兼容读取）。 */
export function inferOutcome(result: Pick<ThetaCheckResult, 'errors' | 'timedOut' | 'outcome'>): ThetaOutcome {
  if (result.outcome) return result.outcome
  return result.timedOut ? 'timeout' : result.errors.length > 0 ? 'type_errors' : 'ok'
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

/**
 * Cap captured output at ~80KB while keeping it line-aligned: slicing mid-line
 * leaves a partial `error TS` diagnostic that either fails the parse regex
 * (missing a real error) or reads as a complete-but-truncated one.
 * Exported for tests.
 */
export function trimCapturedOutput(s: string): string {
  if (s.length <= 100_000) return s
  const cut = s.length - 80_000
  const nl = s.indexOf('\n', cut)
  return nl >= 0 ? s.slice(nl + 1) : s.slice(cut)
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
/** 负缓存（timeout/spawn_error）窗口：60s 内同 cwd 不重复 spawn，返回 backoff。
 *  到期后由既有原子锁放行一个半开探针，成功即写正缓存覆盖失败状态。 */
const NEG_CACHE_TTL_MS = 60_000
const LOCK_STALE_BUFFER_MS = 5_000

interface DiskCacheEntry {
  result: ThetaCheckResult
  cachedAt: number
  /** true = 失败状态（负缓存）。旧格式条目（无此字段）按正缓存读。 */
  negative?: boolean
}

function isNegative(entry: DiskCacheEntry): boolean {
  return entry.negative === true || entry.result.outcome === 'timeout' || entry.result.outcome === 'spawn_error'
}

function backoffResult(entry: DiskCacheEntry): ThetaCheckResult {
  return { errors: [], durationMs: 0, timedOut: false, outcome: 'backoff' }
}

/** 锁竞争且无新鲜结果时的诚实归因——保留旧结果内容但不伪装成 fresh 成功。 */
function busyResult(entry: DiskCacheEntry | null): ThetaCheckResult {
  return entry
    ? { ...entry.result, outcome: 'busy', durationMs: 0, timedOut: false }
    : { errors: [], durationMs: 0, timedOut: false, outcome: 'busy' }
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
    // 旧格式条目（无 outcome 字段）：按 errors/timedOut 推断 outcome
    parsed.result.outcome = inferOutcome(parsed.result as ThetaCheckResult)
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
 *
 * 结果诚实（主控可靠性闭环）：timeout/spawn_error 写入 60s 负缓存，窗口内
 * 返回 `backoff`（不再 spawn）；锁竞争无新鲜结果返回 `busy`（不再伪装成
 * 「空错误且非超时」的假绿）；spawn error 单独归因 `spawn_error`。
 */
export function runThetaCheck(cwd: string, timeoutMs = 15_000): Promise<ThetaCheckResult> {
  // L1: fresh in-process result for this cwd（正/负缓存共用同一 TTL 判定）
  const mem = memCache.get(cwd)
  if (mem) {
    const ttl = isNegative(mem) ? NEG_CACHE_TTL_MS : CACHE_TTL_MS
    if ((Date.now() - mem.cachedAt) < ttl) {
      return Promise.resolve(isNegative(mem) ? backoffResult(mem) : mem.result)
    }
  }
  // L1: in-flight in this process for this cwd
  const flight = memInFlight.get(cwd)
  if (flight) return flight

  const promise = resolveThetaCheck(cwd, timeoutMs).then(result => {
    memCache.set(cwd, { result, cachedAt: Date.now(), negative: isNegativeOutcome(result) })
    memInFlight.delete(cwd)
    return result
  }).catch(err => {
    memInFlight.delete(cwd)
    throw err
  })
  memInFlight.set(cwd, promise)
  return promise
}

function isNegativeOutcome(result: ThetaCheckResult): boolean {
  return result.outcome === 'timeout' || result.outcome === 'spawn_error'
}

async function resolveThetaCheck(cwd: string, timeoutMs: number): Promise<ThetaCheckResult> {
  // L2: fresh on-disk result shared across processes
  const disk = readDiskCache(cwd)
  if (disk) {
    const age = Date.now() - disk.cachedAt
    const ttl = isNegative(disk) ? NEG_CACHE_TTL_MS : CACHE_TTL_MS
    if (age < ttl) {
      return isNegative(disk) ? backoffResult(disk) : disk.result
    }
  }
  // Cross-process in-flight dedup: only the lock winner spawns tsc.
  if (!tryAcquireLock(cwd, timeoutMs)) {
    // Another process is running tsc. 有新鲜结果 → 上面已返回；这里只剩
    // 「无新鲜结果」：显式 busy（保留旧内容但不伪装 fresh），绝不返回假绿。
    return busyResult(disk)
  }
  try {
    const result = await runThetaCheckInner(cwd, timeoutMs)
    // 失败状态（timeout/spawn_error）写 60s 负缓存；成功/有错误写 15s 正缓存
    // （覆盖旧负缓存 = 半开探针成功，失败状态清除）。
    writeDiskCache(cwd, { result, cachedAt: Date.now(), negative: isNegativeOutcome(result) })
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

/** Resolve a runnable tsc command, preferring the project-local binary so we
 *  don't depend on `npx` (whose Windows form is npx.cmd and needs a shell) and
 *  picking tsc.cmd on Windows where the extension-less script is unrunnable.
 *  Falls back to the TypeScript compiler shipped with the running process so
 *  theta-check works against temporary fixture projects that have no
 *  node_modules of their own. */
function resolveTscCommand(cwd: string): { command: string; args: string[]; useShell: boolean } {
  const bin = join(cwd, 'node_modules', '.bin')
  const candidates = process.platform === 'win32'
    ? [join(bin, 'tsc.cmd'), join(bin, 'tsc')]
    : [join(bin, 'tsc')]
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      const useShell = process.platform === 'win32' && candidate.toLowerCase().endsWith('.cmd')
      return { command: useShell ? `"${candidate}"` : candidate, args: ['--noEmit', '--skipLibCheck'], useShell }
    }
  }
  // Fallback 1: TypeScript compiler bundled with the running process.
  try {
    const bundledTsc = require.resolve('typescript/bin/tsc')
    return { command: bundledTsc, args: ['--noEmit', '--skipLibCheck'], useShell: false }
  } catch {
    // Fallback 2: npx → node + npx-cli.js so Windows packaged / bundled-node
    // launches don't need npx.cmd + shell.
    const npxArgs = ['-p', 'typescript', 'tsc', '--noEmit', '--skipLibCheck']
    const resolved = resolveNpmCliCommand('npx', npxArgs)
    return { command: resolved.command, args: resolved.args, useShell: false }
  }
}

function runThetaCheckInner(cwd: string, timeoutMs: number): Promise<ThetaCheckResult> {
  const start = Date.now()

  return new Promise(resolve => {
    const tsc = resolveTscCommand(cwd)
    const env = tsc.command === process.execPath
      // npx-cli.js fallback path: prepend bundled node dir so the internal
      // npx spawn can find the same node. No-op in dev (nodeDir already in PATH).
      ? buildStdioEnvWithNodePath(undefined, {
          getDefaultEnvironment: () => ({ ...process.env } as Record<string, string>),
        })
      : { ...process.env }
    const child = track(spawn(tsc.command, tsc.args, {
      cwd,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
      shell: tsc.useShell,
    }))

    let stdout = ''
    let stderr = ''
    let settled = false
    let timedOut = false

    const finish = (errors: string[], outcome: ThetaOutcome): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve({ errors, durationMs: Date.now() - start, timedOut: outcome === 'timeout', outcome })
    }

    const timer = setTimeout(() => {
      timedOut = true
      gracefulKill(child)
      setTimeout(() => forceKill(child), 3000)
      finish([], 'timeout')
    }, timeoutMs)

    child.stdout?.on('data', (chunk: Buffer) => {
      stdout += chunk.toString()
      stdout = trimCapturedOutput(stdout)
    })

    child.stderr?.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      stderr = trimCapturedOutput(stderr)
    })

    child.on('close', (code) => {
      if (timedOut) return
      if (code === 0) {
        finish([], 'ok')
        return
      }
      // tsc 非零退出 = 有类型错误（即便本次没解析到文件路径——不伪装成 ok）
      finish(parseTypeScriptErrorFiles(`${stdout}\n${stderr}`), 'type_errors')
    })

    child.on('error', () => {
      // spawn failure (ENOENT, EACCES, etc.) — 单独归因 spawn_error：
      // 不得伪装成 timeout（旧实现 timedOut=true），更不得伪装成绿色。
      // 负缓存由 resolveThetaCheck 统一写入（60s 窗口内不再重复 spawn）。
      finish([], 'spawn_error')
    })
  })
}
