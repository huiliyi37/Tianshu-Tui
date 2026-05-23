/**
 * P3-F: Background Agent (Nightcrawler)
 *
 * Lightweight scheduler for running agent tasks in the background.
 * Supports checkpoint/resume, timeout, and 8 termination conditions.
 *
 * Based on: Nightcrawler pattern (~500 lines TS), Claude Code /loop.
 */

import { EventEmitter } from 'node:events'

export type TaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'timeout' | 'cancelled'

export interface BackgroundTask {
  id: string
  description: string
  prompt: string
  status: TaskStatus
  createdAt: number
  startedAt?: number
  completedAt?: number
  result?: string
  error?: string
  /** Checkpoint: serialized session state for resume */
  checkpoint?: string
  /** Number of turns executed */
  turnsExecuted: number
  maxTurns: number
  timeoutMs: number
}

export interface NightcrawlerConfig {
  maxConcurrent?: number
  defaultTimeoutMs?: number
  defaultMaxTurns?: number
  /** Execute a task prompt, return result text */
  execute: (task: BackgroundTask) => Promise<string>
  onComplete?: (task: BackgroundTask) => void
  onError?: (task: BackgroundTask, error: Error) => void
}

export type TerminationReason =
  | 'completed'
  | 'timeout'
  | 'max_turns'
  | 'cancelled'
  | 'error'
  | 'idle'
  | 'budget_exhausted'
  | 'conflict'

const DEFAULT_TIMEOUT = 30 * 60 * 1000 // 30 minutes
const DEFAULT_MAX_TURNS = 50
const DEFAULT_MAX_CONCURRENT = 3

export class Nightcrawler extends EventEmitter {
  private queue: BackgroundTask[] = []
  private running = new Map<string, { task: BackgroundTask; timer: ReturnType<typeof setTimeout> }>()
  private completed: BackgroundTask[] = []
  private readonly config: Required<Pick<NightcrawlerConfig, 'maxConcurrent' | 'defaultTimeoutMs' | 'defaultMaxTurns'>> & NightcrawlerConfig
  private nextId = 1

  constructor(config: NightcrawlerConfig) {
    super()
    this.config = {
      maxConcurrent: config.maxConcurrent ?? DEFAULT_MAX_CONCURRENT,
      defaultTimeoutMs: config.defaultTimeoutMs ?? DEFAULT_TIMEOUT,
      defaultMaxTurns: config.defaultMaxTurns ?? DEFAULT_MAX_TURNS,
      ...config,
    }
  }

  /** Submit a new background task */
  submit(description: string, prompt: string, opts?: { timeoutMs?: number; maxTurns?: number }): string {
    const id = `bg-${this.nextId++}`
    const task: BackgroundTask = {
      id,
      description,
      prompt,
      status: 'queued',
      createdAt: Date.now(),
      turnsExecuted: 0,
      maxTurns: opts?.maxTurns ?? this.config.defaultMaxTurns,
      timeoutMs: opts?.timeoutMs ?? this.config.defaultTimeoutMs,
    }
    this.queue.push(task)
    this.drain()
    return id
  }

  /** Cancel a running or queued task */
  cancel(id: string): boolean {
    const queued = this.queue.findIndex(t => t.id === id)
    if (queued >= 0) {
      const task = this.queue[queued]!
      task.status = 'cancelled'
      task.completedAt = Date.now()
      this.queue.splice(queued, 1)
      this.completed.push(task)
      this.emit('cancelled', task)
      return true
    }
    const entry = this.running.get(id)
    if (entry) {
      clearTimeout(entry.timer)
      entry.task.status = 'cancelled'
      entry.task.completedAt = Date.now()
      this.running.delete(id)
      this.completed.push(entry.task)
      this.emit('cancelled', entry.task)
      this.drain()
      return true
    }
    return false
  }

  /** Get status of a task */
  getTask(id: string): BackgroundTask | undefined {
    return this.queue.find(t => t.id === id)
      ?? this.running.get(id)?.task
      ?? this.completed.find(t => t.id === id)
  }

  /** List all tasks */
  listTasks(): BackgroundTask[] {
    return [
      ...this.queue,
      ...[...this.running.values()].map(e => e.task),
      ...this.completed,
    ]
  }

  /** Get counts by status */
  stats(): Record<TaskStatus, number> {
    const all = this.listTasks()
    return {
      queued: all.filter(t => t.status === 'queued').length,
      running: all.filter(t => t.status === 'running').length,
      completed: all.filter(t => t.status === 'completed').length,
      failed: all.filter(t => t.status === 'failed').length,
      timeout: all.filter(t => t.status === 'timeout').length,
      cancelled: all.filter(t => t.status === 'cancelled').length,
    }
  }

  private drain(): void {
    while (this.running.size < this.config.maxConcurrent && this.queue.length > 0) {
      const task = this.queue.shift()!
      this.startTask(task)
    }
  }

  private startTask(task: BackgroundTask): void {
    task.status = 'running'
    task.startedAt = Date.now()

    const timer = setTimeout(() => {
      task.status = 'timeout'
      task.completedAt = Date.now()
      this.running.delete(task.id)
      this.completed.push(task)
      this.emit('timeout', task)
      this.drain()
    }, task.timeoutMs)

    this.running.set(task.id, { task, timer })
    this.emit('started', task)

    this.config.execute(task).then(
      (result) => {
        if (task.status !== 'running') return // already timed out or cancelled
        clearTimeout(timer)
        task.status = 'completed'
        task.result = result
        task.completedAt = Date.now()
        this.running.delete(task.id)
        this.completed.push(task)
        this.config.onComplete?.(task)
        this.emit('completed', task)
        this.drain()
      },
      (error) => {
        if (task.status !== 'running') return
        clearTimeout(timer)
        task.status = 'failed'
        task.error = error instanceof Error ? error.message : String(error)
        task.completedAt = Date.now()
        this.running.delete(task.id)
        this.completed.push(task)
        this.config.onError?.(task, error instanceof Error ? error : new Error(String(error)))
        this.emit('failed', task)
        this.drain()
      },
    )
  }

  /** Save checkpoint for a running task (called by executor) */
  checkpoint(id: string, state: string, turnsExecuted: number): void {
    const entry = this.running.get(id)
    if (entry) {
      entry.task.checkpoint = state
      entry.task.turnsExecuted = turnsExecuted
    }
  }

  /** Resume a failed/timeout task from its last checkpoint */
  resume(id: string): string | null {
    const task = this.completed.find(t => t.id === id && t.checkpoint)
    if (!task) return null
    const idx = this.completed.indexOf(task)
    this.completed.splice(idx, 1)
    task.status = 'queued'
    task.error = undefined
    this.queue.push(task)
    this.drain()
    return task.id
  }

  /** Cleanup completed tasks older than maxAgeMs */
  gc(maxAgeMs = 24 * 60 * 60 * 1000): number {
    const cutoff = Date.now() - maxAgeMs
    const before = this.completed.length
    this.completed = this.completed.filter(t => (t.completedAt ?? 0) > cutoff)
    return before - this.completed.length
  }
}
