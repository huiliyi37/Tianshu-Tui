/**
 * Resident script host for computer_use drivers.
 *
 * Every computer_use action used to spawn a fresh osascript / powershell.exe.
 * The fixed cost is large: osascript pays ~0.6s process start + System Events
 * handshake per call (measured), PowerShell pays 1-3s of Add-Type JIT. With
 * the feedback loop each action makes TWO calls (action + tree snapshot), so
 * a resident child that keeps the interpreter, the SE connection and the
 * compiled .NET types alive amortizes all of that to near zero.
 *
 * Protocol (line-oriented over stdio):
 *   request  → one JSON line on stdin:  {"id": 1, "b64": "<base64 code>"}
 *   response ← one stdout line prefixed with the sentinel:
 *              #RIVET#{"id": 1, "ok": true, "out": "..."}
 *              #RIVET#{"id": 1, "ok": false, "err": "..."}
 * Code travels as base64 so newlines/quotes in scripts can't break framing.
 * Non-sentinel stdout lines (stray script output) are ignored.
 *
 * Lifecycle: lazy spawn on first run; requests are strictly serialized (the
 * REPLs are single-threaded); a timeout SIGKILLs the child (a wedged Apple
 * Event cannot be interrupted any other way) and the next run respawns; two
 * consecutive spawn failures disable the host permanently so callers fall
 * back to their one-shot execFile path. An idle TTL reaps the child so a
 * finished session doesn't hold an osascript/powershell process forever.
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'

export interface ScriptHostOptions {
  command: string
  args: string[]
  /** Idle milliseconds before the child is reaped. Default 120s. */
  idleTtlMs?: number
  /** Consecutive spawn failures before the host disables itself. Default 2. */
  maxSpawnFailures?: number
}

export interface ScriptHost {
  /**
   * Run a code payload in the resident child. Rejects with the child-reported
   * error, or on timeout/crash. Throws HostUnavailableError when the host is
   * disabled (spawn kept failing or RIVET_CU_HOST=0) — callers should fall
   * back to their one-shot path.
   */
  run(code: string, timeoutMs: number): Promise<string>
  /** Whether run() can be attempted at all (not disabled). */
  available(): boolean
  /** Kill the child and reject pending work. Safe to call repeatedly. */
  dispose(): void
}

export class HostUnavailableError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'HostUnavailableError'
  }
}

export const SENTINEL = '#RIVET#'

const DEFAULT_IDLE_TTL_MS = 120_000
const DEFAULT_MAX_SPAWN_FAILURES = 2

export function hostEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return env.RIVET_CU_HOST !== '0'
}

interface Pending {
  id: number
  resolve: (out: string) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

/** Track live hosts so a process exit never leaves zombie children. */
const liveHosts = new Set<ScriptHost>()
let exitHookInstalled = false
function installExitHook(): void {
  if (exitHookInstalled) return
  exitHookInstalled = true
  process.on('exit', () => {
    for (const host of liveHosts) host.dispose()
  })
}

export function createScriptHost(options: ScriptHostOptions): ScriptHost {
  const idleTtlMs = options.idleTtlMs ?? DEFAULT_IDLE_TTL_MS
  const maxSpawnFailures = options.maxSpawnFailures ?? DEFAULT_MAX_SPAWN_FAILURES

  let child: ChildProcessWithoutNullStreams | null = null
  let disabled = !hostEnabled()
  let spawnFailures = 0
  let nextId = 1
  let pending: Pending | null = null
  let queue: Array<() => void> = []
  let stdoutBuf = ''
  let idleTimer: NodeJS.Timeout | null = null

  function clearIdle(): void {
    if (idleTimer) {
      clearTimeout(idleTimer)
      idleTimer = null
    }
  }

  function armIdle(): void {
    clearIdle()
    idleTimer = setTimeout(() => {
      if (!pending && queue.length === 0) killChild()
    }, idleTtlMs)
    idleTimer.unref()
  }

  function killChild(): void {
    clearIdle()
    if (child) {
      child.removeAllListeners()
      child.stdout.removeAllListeners()
      child.stderr.removeAllListeners()
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead
      }
      child = null
    }
    stdoutBuf = ''
  }

  function failPending(err: Error): void {
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
      pending = null
    }
  }

  function onStdout(chunk: Buffer): void {
    stdoutBuf += chunk.toString('utf8')
    let nl: number
    while ((nl = stdoutBuf.indexOf('\n')) !== -1) {
      const line = stdoutBuf.slice(0, nl).replace(/\r$/, '')
      stdoutBuf = stdoutBuf.slice(nl + 1)
      if (!line.startsWith(SENTINEL)) continue
      let msg: { id?: number; ok?: boolean; out?: string; err?: string }
      try {
        msg = JSON.parse(line.slice(SENTINEL.length)) as typeof msg
      } catch {
        continue
      }
      if (!pending || msg.id !== pending.id) continue
      const done = pending
      clearTimeout(done.timer)
      pending = null
      if (msg.ok) done.resolve(msg.out ?? '')
      else done.reject(new Error(msg.err || 'script host error'))
      drainQueue()
    }
  }

  function onChildGone(reason: string, unavailable = false): void {
    child = null
    stdoutBuf = ''
    failPending(unavailable ? new HostUnavailableError(reason) : new Error(reason))
    drainQueue()
  }

  function ensureChild(): boolean {
    if (child) return true
    if (disabled) return false
    try {
      child = spawn(options.command, options.args, { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch {
      child = null
      spawnFailures++
      if (spawnFailures >= maxSpawnFailures) disabled = true
      return false
    }
    const current = child
    current.on('error', () => {
      if (child === current) {
        spawnFailures++
        if (spawnFailures >= maxSpawnFailures) disabled = true
        // Spawn failure means the code never ran — safe for callers to fall
        // back to the one-shot path (unlike a timeout or mid-run crash).
        onChildGone('script host failed to start', true)
      }
    })
    current.on('exit', () => {
      if (child === current) onChildGone('script host exited unexpectedly')
    })
    current.stdout.on('data', onStdout)
    // stderr is drained but unused: bootstrap diagnostics only.
    current.stderr.on('data', () => {})
    // A successful spawn event resets the failure streak.
    current.once('spawn', () => {
      spawnFailures = 0
    })
    // The resident child must not hold the parent's event loop open — the
    // in-flight request timer (ref'd) does that while work is pending. The
    // stdio pipes are net.Sockets at runtime; their unref isn't in the
    // stream types.
    current.unref()
    for (const stream of [current.stdin, current.stdout, current.stderr]) {
      ;(stream as unknown as { unref?: () => void }).unref?.()
    }
    installExitHook()
    liveHosts.add(host)
    return true
  }

  function drainQueue(): void {
    const next = queue.shift()
    if (next) next()
    else armIdle()
  }

  function runNow(code: string, timeoutMs: number, resolve: (out: string) => void, reject: (err: Error) => void): void {
    if (!ensureChild() || !child) {
      reject(new HostUnavailableError('script host unavailable'))
      drainQueue()
      return
    }
    clearIdle()
    const id = nextId++
    // Deliberately NOT unref'd: with the child unref'd, this ref'd timer is
    // what keeps the event loop alive while a request is in flight.
    const timer = setTimeout(() => {
      // A wedged Apple Event / UIA call cannot be cancelled — kill the child
      // so the next request gets a fresh one.
      killChild()
      failPending(new Error(`script host request timed out after ${timeoutMs}ms`))
      drainQueue()
    }, timeoutMs)
    pending = { id, resolve, reject, timer }
    const payload = JSON.stringify({ id, b64: Buffer.from(code, 'utf8').toString('base64') })
    try {
      child.stdin.write(payload + '\n')
    } catch (err) {
      killChild()
      failPending(err instanceof Error ? err : new Error(String(err)))
      drainQueue()
    }
  }

  const host: ScriptHost = {
    run(code: string, timeoutMs: number): Promise<string> {
      return new Promise<string>((resolve, reject) => {
        if (disabled) {
          reject(new HostUnavailableError('script host disabled'))
          return
        }
        const start = () => runNow(code, timeoutMs, resolve, reject)
        if (pending) queue.push(start)
        else start()
      })
    },
    available(): boolean {
      return !disabled
    },
    dispose(): void {
      queue = []
      failPending(new Error('script host disposed'))
      killChild()
      liveHosts.delete(host)
    },
  }

  return host
}
