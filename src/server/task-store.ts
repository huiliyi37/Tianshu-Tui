/**
 * TaskStore — 任务持久化抽象接口 + per-task JSON MVP 实现
 *
 * 为 TaskRegistry 提供持久化层，隔离存储细节。
 * MVP 用 per-task JSON（`.rivet/tasks/{id}.json`），
 * 未来换 SQLite 只需换实现，不动 TaskRegistry 逻辑。
 */

import { mkdirSync, readFileSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

// ─── Task 类型 ────────────────────────────────────────────────

export type TaskStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled' | 'timed_out'

/** 状态转换优先级：cancelled > timed_out > failed > completed */
const STATUS_PRIORITY: Record<TaskStatus, number> = {
  cancelled: 4,
  timed_out: 3,
  failed: 2,
  completed: 1,
  pending: 0,
  running: 0,
}

/** 检查状态转换是否合法（终态不可被低优先级覆盖） */
export function canTransition(from: TaskStatus, to: TaskStatus): boolean {
  // pending/running 可转到任何状态
  if (from === 'pending' || from === 'running') return true
  // 终态仅可被更高优先级覆盖
  return STATUS_PRIORITY[to] > STATUS_PRIORITY[from]
}

export type TaskSource = 'api' | 'cron' | 'manual' | 'internal'

export interface TaskRecord {
  id: string
  prompt: string
  source: TaskSource
  status: TaskStatus
  createdAt: string
  startedAt?: string
  completedAt?: string
  timeoutMs: number
  callerId: string
  idempotencyKey: string
  /** 如果 force=true 跳过去重 */
  force: boolean
  result?: {
    summary: string
    changedFiles: string[]
    exitCode?: number
  }
  error?: string
}

export interface CreateTaskInput {
  prompt: string
  source: TaskSource
  callerId?: string
  timeoutMs?: number
  force?: boolean
  /** 自定义 idempotency key（不传则自动基于 prompt+caller+bucket 生成） */
  idempotencyKey?: string
}

// ─── TaskStore 接口 ───────────────────────────────────────────

export interface TaskStore {
  save(task: TaskRecord): Promise<void>
  load(id: string): Promise<TaskRecord | null>
  list(filter?: TaskFilter): Promise<TaskRecord[]>
  delete(id: string): Promise<void>
  /** 按 idempotency key 查找已有的非终态 task（去重用） */
  findActiveByIdempotencyKey(key: string): Promise<TaskRecord | null>
}

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  source?: TaskSource
  limit?: number
}

// ─── per-task JSON MVP 实现 ───────────────────────────────────

const DEFAULT_TASKS_DIR = '.rivet/tasks'

export class JsonTaskStore implements TaskStore {
  private dir: string
  private cache = new Map<string, TaskRecord>()

  constructor(dir?: string) {
    this.dir = dir ?? DEFAULT_TASKS_DIR
    mkdirSync(this.dir, { recursive: true })
  }

  async save(task: TaskRecord): Promise<void> {
    this.cache.set(task.id, task)
    const tmpPath = join(this.dir, `${task.id}.tmp`)
    const finalPath = join(this.dir, `${task.id}.json`)
    writeFileSync(tmpPath, JSON.stringify(task, null, 2), 'utf-8')
    // 原子 rename
    const { renameSync } = await import('node:fs')
    renameSync(tmpPath, finalPath)
  }

  async load(id: string): Promise<TaskRecord | null> {
    const cached = this.cache.get(id)
    if (cached) return cached
    try {
      const raw = readFileSync(join(this.dir, `${id}.json`), 'utf-8')
      const record = JSON.parse(raw) as TaskRecord
      this.cache.set(id, record)
      return record
    } catch {
      return null
    }
  }

  async list(filter?: TaskFilter): Promise<TaskRecord[]> {
    const files = readdirSync(this.dir).filter(f => f.endsWith('.json'))
    const results: TaskRecord[] = []
    for (const f of files) {
      try {
        const raw = readFileSync(join(this.dir, f), 'utf-8')
        const record = JSON.parse(raw) as TaskRecord
        if (this.matchesFilter(record, filter)) {
          results.push(record)
        }
      } catch {
        // 损坏文件跳过
      }
    }
    // 按创建时间倒序
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    if (filter?.limit && filter.limit > 0) {
      return results.slice(0, filter.limit)
    }
    return results
  }

  async delete(id: string): Promise<void> {
    this.cache.delete(id)
    try { unlinkSync(join(this.dir, `${id}.json`)) } catch { /* ignore */ }
  }

  async findActiveByIdempotencyKey(key: string): Promise<TaskRecord | null> {
    const all = await this.list()
    return all.find(r =>
      r.idempotencyKey === key &&
      r.status !== 'completed' &&
      r.status !== 'failed' &&
      r.status !== 'cancelled' &&
      r.status !== 'timed_out',
    ) ?? null
  }

  private matchesFilter(record: TaskRecord, filter?: TaskFilter): boolean {
    if (!filter) return true
    if (filter.status) {
      const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
      if (!statuses.includes(record.status)) return false
    }
    if (filter.source && record.source !== filter.source) return false
    return true
  }
}

// ─── 工具函数 ─────────────────────────────────────────────────

/**
 * 复合幂等 key：hash(prompt + caller_id + time_bucket_5min)
 * 5 分钟窗口外的重复 prompt 视为新 task。
 */
export function buildIdempotencyKey(prompt: string, callerId: string, timeMs?: number): string {
  const ts = timeMs ?? Date.now()
  const bucket = Math.floor(ts / (5 * 60 * 1000))
  return hashSimple(`${prompt}|${callerId}|${bucket}`)
}

/** 简单字符串 hash（FNV-1a，无需 crypto 依赖） */
function hashSimple(input: string): string {
  let hash = 2166136261
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return (hash >>> 0).toString(16).padStart(8, '0')
}

export function generateTaskId(): string {
  return `task_${randomUUID().slice(0, 8)}`
}

export function nowISO(): string {
  return new Date().toISOString()
}
