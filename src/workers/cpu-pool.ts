/**
 * Lazy single-worker pool for CPU-bound tasks.
 *
 * Usage from the main thread:
 *   import { cpuPool } from '../workers/cpu-pool.js'
 *   const result = await cpuPool.run('diffUnifiedRaw', [path, before, after, 4000])
 *
 * Design:
 * - Lazy single worker (spawned on first `run()`, `unref()` so it doesn't
 *   keep the process alive).  Tasks are serialised by the worker's own
 *   message-queue — no explicit main-thread queuing needed.
 * - Soft timeout (default 5s): the promise rejects, caller falls back to
 *   inline computation.  The worker may still be crunching — it finishes or
 *   gets terminated by the hard ceiling on the *next* `run()` call.
 * - Hard ceiling (10s stuck): if the worker hasn't responded to any message
 *   for >10s, `terminate()` + recreate on next `run()`.
 * - Crash recovery: `error`/`exit` events mark the worker dead; next `run()`
 *   spawns a fresh one.
 * - Permanent fallback: `RIVET_CPU_POOL=0` env var disables the worker
 *   entirely — all calls reject immediately, forcing inline paths.
 * - Path resolution: tries `./cpu-worker.js` (dist bundle), then
 *   `./cpu-worker.ts` (tsx dev with `--import tsx/esm`).
 */

import { Worker } from 'node:worker_threads'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const SOFT_TIMEOUT_MS = 5000
const HARD_STUCK_MS = 10_000
const DISABLED = process.env.RIVET_CPU_POOL === '0'

// ── Worker path resolution ──

function resolveWorkerPath(): string | null {
  // Dist: tsup mirrors source structure, so cpu-worker.js is at
  // dist/workers/cpu-worker.js alongside dist/main.js.
  const distUrl = new URL('./workers/cpu-worker.js', import.meta.url)
  try {
    const distPath = fileURLToPath(distUrl)
    if (existsSync(distPath)) return distPath
  } catch { /* URL scheme not file: (unlikely), fall through */ }

  // Dev (tsx): the source files are side-by-side in src/workers/.
  const devUrl = new URL('./cpu-worker.ts', import.meta.url)
  try {
    const devPath = fileURLToPath(devUrl)
    if (existsSync(devPath)) return devPath
  } catch { /* ditto */ }

  return null
}

// ── Pool state ──

let _worker: Worker | null = null
let _dead = DISABLED // permanent-disable flag
let _seq = 0
let _lastTaskStart = 0 // timestamp of the most recent postMessage

interface Pending {
  resolve: (value: unknown) => void
  reject: (reason: Error) => void
  clear: () => void
}

const _pending = new Map<number, Pending>()

// ── Internal helpers ──

function spawnWorker(): Worker | null {
  const path = resolveWorkerPath()
  if (!path) return null

  const w = new Worker(path, {
    // tsx dev: enable TypeScript in the worker thread
    execArgv: path.endsWith('.ts') ? ['--import', 'tsx/esm'] : undefined,
  })
  w.unref()
  w.on('message', (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
    const p = _pending.get(msg.id)
    if (!p) return
    _pending.delete(msg.id)
    p.clear()
    if (msg.ok) p.resolve(msg.result)
    else p.reject(new Error(msg.error ?? 'unknown worker error'))
  })
  w.on('error', () => {
    killWorker()
  })
  w.on('exit', () => {
    killWorker()
  })
  return w
}

function killWorker(): void {
  if (!_worker) return
  // Reject all pending promises
  for (const p of _pending.values()) {
    p.clear()
    p.reject(new Error('CPU worker terminated'))
  }
  _pending.clear()
  try { _worker.terminate() } catch { /* already dead */ }
  _worker = null
}

function getWorker(): Worker | null {
  if (_dead) return null

  // Hard-stuck check: if a task has been running >10s, kill and restart
  if (_worker && _lastTaskStart > 0) {
    const stuckMs = Date.now() - _lastTaskStart
    if (stuckMs > HARD_STUCK_MS) {
      killWorker()
    }
  }

  if (!_worker) {
    _worker = spawnWorker()
    if (!_worker) {
      _dead = true
      return null
    }
  }
  return _worker
}

// ── Public API ──

export const cpuPool = {
  /**
   * Run a named task in the worker thread.
   *
   * Returns the task's result on success, or throws an Error if the worker is
   * unavailable / the task times out.  Callers should catch and fall back to
   * inline computation.
   *
   * @param task    — key in the worker's task registry (cpu-worker.ts)
   * @param args    — positional arguments forwarded to the task function
   * @param softMs  — soft timeout in ms (default 5s)
   */
  run(task: string, args: unknown[], softMs = SOFT_TIMEOUT_MS): Promise<unknown> {
    const worker = getWorker()
    if (!worker) return Promise.reject(new Error('CPU pool unavailable'))

    return new Promise<unknown>((resolve, reject) => {
      const id = ++_seq
      let settled = false

      const timer = setTimeout(() => {
        if (settled) return
        settled = true
        _pending.delete(id)
        reject(new Error(`CPU task '${task}' timed out after ${softMs}ms`))
      }, softMs)

      const clear = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
      }

      _pending.set(id, { resolve, reject, clear })
      _lastTaskStart = Date.now()
      worker.postMessage({ id, task, args })
    })
  },

  /** True when the worker is (or can be) running. */
  get available(): boolean {
    return !DISABLED && !_dead
  },
}
