import { spawn, type ChildProcess } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { mkdirSync, createWriteStream, type WriteStream } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'
import { track } from './process-tracker.js'
import { killProcessTree } from './process-kill.js'
import {
  getShellCommand,
  WinStreamDecoder,
  rewriteWindowsNullRedirect,
  rewritePowershellNullRedirect,
} from '../platform.js'
import { debugLog } from '../utils/debug.js'

/** Cap for the in-memory ring buffer kept per job (bytes of decoded text). */
const RING_CAP = 64_000
/** Minimum interval between throttled `output` events (ms). */
const OUTPUT_THROTTLE_MS = 500

export type JobStatus = 'running' | 'exited' | 'killed'

/** Serializable snapshot of a background job — safe to send over SSE / REST. */
export interface JobSnapshot {
  id: string
  command: string
  status: JobStatus
  exitCode?: number
  startedAt: number
  endedAt?: number
  /** Last non-empty line of output (dashboard preview). */
  lastLine: string
  pid?: number
}

export interface JobEvent {
  kind: 'started' | 'output' | 'exit'
  job: JobSnapshot
  /** Present only for `output` events — the newly appended text since last emit. */
  chunk?: string
}

export interface JobSpawnOptions {
  /** The command actually executed (post rtk/mirror/sandbox rewrite). */
  command: string
  /** Original command for display (pre-rewrite). */
  rawCommand: string
  cwd: string
  /** Fully-prepared child environment (sanitized + mirror overlay by caller). */
  env: Record<string, string | undefined>
}

export interface JobAwaitOptions {
  /** Regex source matched against accumulated output; resolves early on a hit. */
  pattern?: string
  timeoutMs?: number
}

export interface JobAwaitResult {
  job: JobSnapshot
  /** True when `pattern` matched the output before exit/timeout. */
  matched: boolean
  timedOut: boolean
  /** Tail of the output ring at resolution time. */
  tail: string
}

interface Waiter {
  resolve: (r: JobAwaitResult) => void
  regex?: RegExp
  timer: ReturnType<typeof setTimeout> | null
}

class BackgroundJob {
  readonly id: string
  readonly command: string
  readonly startedAt = Date.now()
  status: JobStatus = 'running'
  exitCode?: number
  endedAt?: number

  private ring = ''
  private child: ChildProcess | null = null
  private pid?: number
  private logStream: WriteStream | null = null
  private killTimer: ReturnType<typeof setTimeout> | null = null
  private waiters: Waiter[] = []
  private readonly decoderOut = new WinStreamDecoder()
  private readonly decoderErr = new WinStreamDecoder()

  // Output throttling — coalesce bursts into ≤1 event / OUTPUT_THROTTLE_MS.
  private pendingChunk = ''
  private throttleTimer: ReturnType<typeof setTimeout> | null = null

  constructor(
    private readonly opts: JobSpawnOptions,
    private readonly emit: (ev: JobEvent) => void,
  ) {
    this.id = randomUUID().slice(0, 8)
    this.command = opts.rawCommand
  }

  start(logPath: string): void {
    try {
      this.logStream = createWriteStream(logPath, { flags: 'a' })
      // Disk logging is best-effort — a write/open failure (e.g. dir removed)
      // must never throw asynchronously and crash the process.
      this.logStream.on('error', () => { this.logStream = null })
    } catch {
      this.logStream = null
    }

    const shell = getShellCommand()
    let commandToRun = this.opts.command
    if (shell.kind === 'bash') {
      commandToRun = rewriteWindowsNullRedirect(this.opts.command)
    } else if (shell.kind === 'powershell') {
      commandToRun = `$OutputEncoding = [Console]::OutputEncoding = [System.Text.Encoding]::UTF8; ${rewritePowershellNullRedirect(this.opts.command)}`
    } else if (shell.kind === 'cmd') {
      commandToRun = `chcp 65001 > nul && ${this.opts.command}`
    }

    debugLog(`[job-spawn] id=${this.id} kind=${shell.kind} cwd=${this.opts.cwd}`)
    const child = track(spawn(shell.cmd, [...shell.args, commandToRun], {
      cwd: this.opts.cwd,
      env: this.opts.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      // Match bash.ts: detached process group on POSIX so kill(-pid) reaps the
      // whole tree; NOT detached on Windows (breaks stdio pipes on cmd.exe).
      detached: process.platform !== 'win32',
      windowsHide: true,
    }))
    this.child = child
    this.pid = child.pid

    child.stdout?.on('data', (d: Buffer) => this.onData(this.decoderOut.write(d)))
    child.stderr?.on('data', (d: Buffer) => this.onData(this.decoderErr.write(d)))
    child.on('close', (code) => this.onExit(code ?? 1))
    child.on('error', (err) => {
      this.onData(`\n[job error] ${err.message}\n`)
      this.onExit(1)
    })

    this.emit({ kind: 'started', job: this.snapshot() })
  }

  private onData(text: string): void {
    if (!text) return
    this.ring += text
    if (this.ring.length > RING_CAP) this.ring = this.ring.slice(-RING_CAP)
    try { this.logStream?.write(text) } catch { /* best-effort */ }

    // Resolve any pattern waiters whose regex now matches the accumulated ring.
    if (this.waiters.length > 0) {
      const remaining: Waiter[] = []
      for (const w of this.waiters) {
        if (w.regex && w.regex.test(this.ring)) {
          if (w.timer) clearTimeout(w.timer)
          w.resolve({ job: this.snapshot(), matched: true, timedOut: false, tail: this.tail() })
        } else {
          remaining.push(w)
        }
      }
      this.waiters = remaining
    }

    this.pendingChunk += text
    if (!this.throttleTimer) {
      this.throttleTimer = setTimeout(() => this.flushOutput(), OUTPUT_THROTTLE_MS)
    }
  }

  private flushOutput(): void {
    if (this.throttleTimer) { clearTimeout(this.throttleTimer); this.throttleTimer = null }
    if (!this.pendingChunk) return
    const chunk = this.pendingChunk
    this.pendingChunk = ''
    this.emit({ kind: 'output', job: this.snapshot(), chunk })
  }

  private onExit(code: number): void {
    if (this.killTimer) { clearTimeout(this.killTimer); this.killTimer = null }
    if (this.status !== 'running') {
      // Already killed — keep the killed status but record the code/time.
      this.exitCode = code
      this.endedAt = Date.now()
    } else {
      this.status = 'exited'
      this.exitCode = code
      this.endedAt = Date.now()
    }
    this.ring += this.decoderOut.end() + this.decoderErr.end()
    if (this.ring.length > RING_CAP) this.ring = this.ring.slice(-RING_CAP)
    this.flushOutput()
    try { this.logStream?.end() } catch { /* best-effort */ }
    this.logStream = null

    for (const w of this.waiters) {
      if (w.timer) clearTimeout(w.timer)
      w.resolve({ job: this.snapshot(), matched: false, timedOut: false, tail: this.tail() })
    }
    this.waiters = []
    this.emit({ kind: 'exit', job: this.snapshot() })
  }

  await(opts: JobAwaitOptions): Promise<JobAwaitResult> {
    if (this.status !== 'running') {
      return Promise.resolve({ job: this.snapshot(), matched: false, timedOut: false, tail: this.tail() })
    }
    let regex: RegExp | undefined
    if (opts.pattern) {
      try { regex = new RegExp(opts.pattern) } catch { regex = undefined }
    }
    // Fast path: pattern already satisfied by buffered output.
    if (regex && regex.test(this.ring)) {
      return Promise.resolve({ job: this.snapshot(), matched: true, timedOut: false, tail: this.tail() })
    }
    return new Promise<JobAwaitResult>((resolve) => {
      const waiter: Waiter = { resolve, regex, timer: null }
      const timeoutMs = opts.timeoutMs ?? 120_000
      waiter.timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w !== waiter)
        resolve({ job: this.snapshot(), matched: false, timedOut: true, tail: this.tail() })
      }, timeoutMs)
      this.waiters.push(waiter)
    })
  }

  kill(): void {
    if (this.status !== 'running' || !this.child) return
    this.status = 'killed'
    killProcessTree(this.child, 'SIGTERM')
    const child = this.child
    this.killTimer = setTimeout(() => {
      this.killTimer = null
      killProcessTree(child, 'SIGKILL')
    }, 3000)
    if (typeof this.killTimer.unref === 'function') this.killTimer.unref()
  }

  logs(): string {
    return this.ring
  }

  private tail(limit = 4000): string {
    return this.ring.length > limit ? this.ring.slice(-limit) : this.ring
  }

  snapshot(): JobSnapshot {
    return {
      id: this.id,
      command: this.command,
      status: this.status,
      exitCode: this.exitCode,
      startedAt: this.startedAt,
      endedAt: this.endedAt,
      lastLine: lastNonEmptyLine(this.ring),
      pid: this.pid,
    }
  }
}

/** Public handle injected into tools (bash / job) — hides the class internals. */
export interface JobRegistry {
  spawn(opts: JobSpawnOptions): JobSnapshot
  await(id: string, opts: JobAwaitOptions): Promise<JobAwaitResult | null>
  list(): JobSnapshot[]
  logs(id: string): string | null
  kill(id: string): boolean
}

/** Per-session collection of background jobs; also an event source for the server. */
export class SessionJobs extends EventEmitter implements JobRegistry {
  private jobs = new Map<string, BackgroundJob>()

  constructor(private readonly logDir: string) {
    super()
  }

  spawn(opts: JobSpawnOptions): JobSnapshot {
    const job = new BackgroundJob(opts, (ev) => this.emit('event', ev))
    this.jobs.set(job.id, job)
    let logPath = ''
    try {
      mkdirSync(this.logDir, { recursive: true })
      logPath = join(this.logDir, `${job.id}.log`)
    } catch { /* best-effort — job still runs, just no on-disk log */ }
    job.start(logPath)
    return job.snapshot()
  }

  await(id: string, opts: JobAwaitOptions): Promise<JobAwaitResult | null> {
    const job = this.jobs.get(id)
    if (!job) return Promise.resolve(null)
    return job.await(opts)
  }

  list(): JobSnapshot[] {
    return [...this.jobs.values()].map((j) => j.snapshot()).sort((a, b) => b.startedAt - a.startedAt)
  }

  logs(id: string): string | null {
    return this.jobs.get(id)?.logs() ?? null
  }

  kill(id: string): boolean {
    const job = this.jobs.get(id)
    if (!job) return false
    job.kill()
    return true
  }

  /** Terminate every running job — call on session close to avoid orphans. */
  killAll(): void {
    for (const job of this.jobs.values()) job.kill()
  }

  hasRunning(): boolean {
    for (const job of this.jobs.values()) {
      if (job.status === 'running') return true
    }
    return false
  }
}

function lastNonEmptyLine(text: string): string {
  const lines = text.split('\n')
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!.trim()
    if (line) return line.length > 200 ? line.slice(0, 200) : line
  }
  return ''
}
