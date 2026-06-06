/**
 * Cron Scheduler — server 层持久化定时调度器
 *
 * 功能：
 * 1. 持久化 schedule 表 → .rivet/scheduled_tasks.json（原子写 tmp+rename）
 * 2. 时间触发 tick（间隔检查，到点 → TaskRegistry.createTask(source:'cron')）
 * 3. 启动时从文件恢复 schedule 表
 *
 * 部署假设：
 * - 单 daemon 进程则锁 YAGNI，scheduler 为进程内单例
 * - 多进程部署需配合 cron-lock.ts（PID 租约锁）保证单调度器
 */

import { readFileSync, writeFileSync, renameSync, existsSync } from 'node:fs'
import { randomUUID } from 'node:crypto'

// ─── Types ────────────────────────────────────────────────────

export type CronTriggerType = 'interval' | 'cron' | 'oneshot'

export interface CronTrigger {
  type: CronTriggerType
  /** interval: ms 数；cron: cron 表达式字符串；oneshot: ISO 时间戳 */
  spec: string
}

export interface ScheduledTask {
  id: string
  prompt: string
  allowedTools: string[]
  trigger: CronTrigger
  /** recurring 任务的最大存活时间（毫秒），超期自动清理 */
  recurringMaxAgeMs?: number
  /** 关联的 agent/runtime ID */
  agentId?: string
  /** 创建时间 */
  createdAt: string
  /** 上次触发时间 */
  lastTriggeredAt?: string
  /** 触发次数（oneshot 触发一次后删除） */
  triggerCount: number
}

export type ScheduleTable = ScheduledTask[]

export interface CronSchedulerConfig {
  /** schedule 表文件路径 */
  schedulePath?: string
  /** tick 间隔（毫秒），默认 30 秒 */
  tickIntervalMs?: number
  /** TaskRegistry 的 createTask 方法引用 */
  onCreateTask?: (prompt: string, allowedTools: string[], agentId?: string) => Promise<unknown>
}

// ─── Persistence ──────────────────────────────────────────────

const DEFAULT_SCHEDULE_PATH = '.rivet/scheduled_tasks.json'

/** 原子写入：写临时文件 → rename */
function atomicWriteSchedule(path: string, table: ScheduleTable): void {
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

/** 计算指定 cron 表达式下一次触发的时间戳 */
function nextCronTime(expr: string, from: number): number | null {
  // 简单 cron 解析：分 时 日 月 周（仅支持数字和 *）
  const parts = expr.trim().split(/\s+/)
  if (parts.length !== 5) return null

  const now = new Date(from)
  // 简单实现：只支持 "minute hour * * *" 格式
  // 完整 cron 实现超出 MVP 范围
  try {
    const minute = parseInt(parts[0]!, 10)
    const hour = parseInt(parts[1]!, 10)
    if (isNaN(minute) || isNaN(hour)) return null

    const next = new Date(now)
    next.setUTCSeconds(0, 0)
    next.setUTCHours(hour, minute, 0, 0)

    // 如果今天的这个时间已过，推到明天
    if (next.getTime() <= now.getTime()) {
      next.setDate(next.getDate() + 1)
    }

    return next.getTime()
  } catch {
    return null
  }
}

/** 计算下次触发时间（毫秒时间戳），null 表示不再触发 */
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
    case 'cron': {
      return nextCronTime(task.trigger.spec, now)
    }
    case 'oneshot': {
      // oneshot 未触发 → 返回 spec 时间；已触发 → 删除
      if (task.triggerCount > 0) return null
      const ts = new Date(task.trigger.spec).getTime()
      if (isNaN(ts)) return null
      // 已过期但未触发 → 立即触发
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

  constructor(config: CronSchedulerConfig) {
    this.schedulePath = config.schedulePath ?? DEFAULT_SCHEDULE_PATH
    this.tickIntervalMs = config.tickIntervalMs ?? 30_000
    this.onCreateTask = config.onCreateTask ?? (async () => {})
  }

  // ─── Schedule Management ──────────────────────────────────

  /** 添加定时任务 */
  add(task: ScheduledTask): void {
    // 检查已有的 oneshot 是否过期
    if (task.trigger.type === 'oneshot') {
      const ts = new Date(task.trigger.spec).getTime()
      if (!isNaN(ts) && ts < Date.now()) {
        // oneshot 已过期，直接触发并跳过持久化
        this.fireTask(task)
        return
      }
    }
    this.table.push(task)
    this.persist()
  }

  /** 删除定时任务 */
  remove(id: string): boolean {
    const idx = this.table.findIndex(t => t.id === id)
    if (idx === -1) return false
    this.table.splice(idx, 1)
    this.persist()
    return true
  }

  /** 列出所有 schedule */
  list(): ScheduleTable {
    return [...this.table]
  }

  /** 获取单个 schedule */
  get(id: string): ScheduledTask | undefined {
    return this.table.find(t => t.id === id)
  }

  // ─── Lifecycle ─────────────────────────────────────────────

  /** 启动调度器：恢复持久化表 + 开始 tick */
  start(): void {
    if (this.running) return

    // 恢复持久化表（合并非重复条目）
    const persisted = loadSchedule(this.schedulePath)
    const existingIds = new Set(this.table.map(t => t.id))
    for (const task of persisted) {
      if (!existingIds.has(task.id)) {
        this.table.push(task)
      }
    }
    this.running = true

    // 开始 tick
    this.tickTimer = setInterval(() => {
      this.tick(Date.now()).catch(() => {})
    }, this.tickIntervalMs)

    // 立即执行一次 tick
    this.tick(Date.now()).catch(() => {})
  }

  /** 停止调度器 */
  stop(): void {
    this.running = false
    if (this.tickTimer) {
      clearInterval(this.tickTimer)
      this.tickTimer = null
    }
  }

  /** 是否正在运行 */
  isRunning(): boolean {
    return this.running
  }

  // ─── Internal ──────────────────────────────────────────────

  private async tick(now: number): Promise<void> {
    const toFire: ScheduledTask[] = []
    const toRemove: string[] = []

    for (const task of this.table) {
      // recurring 超 maxAge → 清理
      if (task.recurringMaxAgeMs && task.createdAt) {
        const age = now - new Date(task.createdAt).getTime()
        if (age > task.recurringMaxAgeMs) {
          toRemove.push(task.id)
          continue
        }
      }

      const next = computeNextTrigger(task, now)
      if (next === null) {
        // 不再触发的任务（如已完成的 oneshot）
        toRemove.push(task.id)
        continue
      }

      if (next <= now) {
        toFire.push(task)
      }
    }

    // 清理过期/已完成任务
    if (toRemove.length > 0) {
      this.table = this.table.filter(t => !toRemove.includes(t.id))
    }

    // 触发到点任务
    for (const task of toFire) {
      // 更新触发元数据
      task.lastTriggeredAt = new Date(now).toISOString()
      task.triggerCount++

      // oneshot 触发即删
      if (task.trigger.type === 'oneshot') {
        this.table = this.table.filter(t => t.id !== task.id)
      }

      await this.fireTask(task)
    }

    if (toFire.length > 0 || toRemove.length > 0) {
      this.persist()
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
