/**
 * Cron Scheduler — server 层持久化定时调度器
 *
 * 功能：
 * 1. 持久化 schedule 表 → .rivet/scheduled_tasks.json（原子写 tmp+rename）
 * 2. 时间触发 tick（间隔检查，到点 → TaskRegistry.createTask(source:'cron')）
 * 3. 启动时从文件恢复 schedule 表
 */

import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { randomUUID } from 'node:crypto'

// ─── Types ────────────────────────────────────────────────────

export type CronTriggerType = 'interval' | 'cron' | 'oneshot'

export interface CronTrigger {
  type: CronTriggerType
  spec: string
}

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: CronTrigger
  recurringMaxAgeMs?: number
  agentId?: string
  createdAt: string
  lastTriggeredAt?: string
  triggerCount: number
}

export type ScheduleTable = ScheduledTask[]

export interface CronSchedulerConfig {
  schedulePath?: string
  tickIntervalMs?: number
  onCreateTask?: (prompt: string, allowedTools: string[], agentId?: string) => Promise<unknown>
}

// ─── Persistence ──────────────────────────────────────────────

const DEFAULT_SCHEDULE_PATH = '.rivet/scheduled_tasks.json'

function atomicWriteSchedule(path: string, table: ScheduleTable): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmpPath = path + '.tmp'
  writeFileSync(tmpPath, JSON.stringify(table, null, 2), 'utf-8')
  renameSync(tmpPath, path)
}

function loadSchedule(path: string): ScheduleTable {
  if (!existsSync(path)) return []
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed as ScheduleTable
  } catch {
    return []
  }
}

// ─── Next Tick Calculation ────────────────────────────────────

function nextCronTime(expr: string, from: number): number | null {
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null
  const now = new Date(from)
  try {
    const minute = parseInt(parts[0]!, 10)
    const hour = parseInt(parts[1]!, 10)
    if (isNaN(minute) || isNaN(hour)) return null
    const next = new Date(now)
    next.setUTCSeconds(0, 0)
    next.setUTCHours(hour, minute, 0, 0)
    if (next.getTime() <= now.getTime()) {
      next.setUTCDate(next.getUTCDate() + 1)
    }
    return next.getTime()
  } catch {
    return null
  }
}

export function computeNextTrigger(task: ScheduledTask, now: number): number | null {
  switch (task.trigger.type) {
    case 'interval': {
      const ms = parseInt(task.trigger.spec, 10)
      if (isNaN(ms) || ms <= 0) return null
      const base = task.lastTriggeredAt
        ? new Date(task.lastTriggeredAt).getTime()
        : new Date(task.createdAt).getTime()
      return base + ms
    }
    case 'cron':
      return nextCronTime(task.trigger.spec, now)
    case 'oneshot': {
      if (task.triggerCount > 0) return null
      const ts = new Date(task.trigger.spec).getTime()
      if (isNaN(ts)) return null
      return ts <= now ? now : ts
    }
  }
}

// ─── Cron Scheduler ───────────────────────────────────────────

export class CronScheduler {
  private schedulePath: string
  private tickIntervalMs: number
  private onCreateTask: (prompt: string, allowedTools: string[], agentId?: string) => Promise<unknown>
  private table: ScheduleTable = []
  private tickTimer: ReturnType<typeof setInterval> | null = null
  private running = false
  private ticking = false

  constructor(config: CronSchedulerConfig) {
    this.schedulePath = config.schedulePath ?? DEFAULT_SCHEDULE_PATH
    this.tickIntervalMs = config.tickIntervalMs ?? 30_000
    this.onCreateTask = config.onCreateTask ?? (async () => {})
  }

  // ─── Schedule Management ──────────────────────────────────

  add(task: ScheduledTask): void {
    if (task.trigger.type === 'cron') {
      const next = nextCronTime(task.trigger.spec, Date.now())
      if (next === null) {
        throw new Error(
          `Invalid cron expression "${task.trigger.spec}". Only "minute hour * * *" supported.`
        )
      }
    }
    if (task.trigger.type === 'interval') {
      const ms = parseInt(task.trigger.spec, 10)
      if (isNaN(ms) || ms <= 0) {
        throw new Error(
          `Invalid interval "${task.trigger.spec}". Must be a positive integer (milliseconds).`
        )
      }
    }
    if (task.trigger.type === 'oneshot') {
      const ts = new Date(task.trigger.spec).getTime()
      if (!isNaN(ts) && ts < Date.now()) {
        this.fireTask(task)
        return
      }
    }
    this.table.push(task)
    this.persist()
  }

  remove(id: string): boolean {
    const idx = this.table.findIndex(t => t.id === id)
    if (idx === -1) return false
    this.table.splice(idx, 1)
    this.persist()
    return true
  }

  list(): ScheduleTable {
    return [...this.table]
  }

  get(id: string): ScheduledTask | undefined {
    return this.table.find(t => t.id === id)
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  start(): void {
    if (this.running) return
    const persisted = loadSchedule(this.schedulePath)
    const existingIds = new Set(this.table.map(t => t.id))
    for (const task of persisted) {
      if (!existingIds.has(task.id)) {
        this.table.push(task)
      }
    }
    this.running = true
    this.tickTimer = setInterval(() => {
      this.tick(Date.now()).catch(() => {})
    }, this.tickIntervalMs)
    this.tick(Date.now()).catch(() => {})
  }

  stop(): void {
    this.running = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  isRunning(): boolean {
    return this.running
  }

  // ─── Internal ──────────────────────────────────────────────

  private async tick(now: number): Promise<void> {
    if (this.ticking) return
    this.ticking = true
    try {
      const toFire: ScheduledTask[] = []
      const toRemove: string[] = []

      for (const task of this.table) {
        if (task.recurringMaxAgeMs && task.createdAt) {
          const age = now - new Date(task.createdAt).getTime()
          if (age > task.recurringMaxAgeMs) {
            toRemove.push(task.id)
            continue
          }
        }

        const next = computeNextTrigger(task, now)
        if (next === null) {
          // oneshot 已完成 → 删除；recurring 的 null 是坏数据 → 保留跳过
          if (task.trigger.type === 'oneshot') {
            toRemove.push(task.id)
          }
          continue
        }

        if (next <= now) {
          toFire.push(task)
        }
      }

      if (toRemove.length > 0) {
        this.table = this.table.filter(t => !toRemove.includes(t.id))
      }

      for (const task of toFire) {
        task.lastTriggeredAt = new Date(now).toISOString()
        task.triggerCount++
        if (task.trigger.type === 'oneshot') {
          this.table = this.table.filter(t => t.id !== task.id)
        }
        await this.fireTask(task)
      }

      if (toFire.length > 0 || toRemove.length > 0) {
        this.persist()
      }
    } finally {
      this.ticking = false
    }
  }

  private async fireTask(task: ScheduledTask): Promise<void> {
    try {
      await this.onCreateTask(task.prompt, task.allowedTools, task.agentId)
    } catch {
      // 任务创建失败不阻塞其他调度
    }
  }

  private persist(): void {
    try {
      atomicWriteSchedule(this.schedulePath, this.table)
    } catch {
      // 持久化失败不阻塞调度
    }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

export function createScheduledTask(
  prompt: string,
  trigger: CronTrigger,
  allowedTools: string[] = [],
  opts?: { recurringMaxAgeMs?: number; agentId?: string },
): ScheduledTask {
  return {
    id: `cron_${randomUUID().slice(0, 8)}`,
    prompt,
    allowedTools,
    trigger,
    recurringMaxAgeMs: opts?.recurringMaxAgeMs,
    agentId: opts?.agentId,
    createdAt: new Date().toISOString(),
    triggerCount: 0,
  }
}
