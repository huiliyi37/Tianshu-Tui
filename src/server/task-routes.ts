/**
 * Task API 路由处理器
 *
 * Spec B Phase 1: 持久化 + 审计 API
 *
 * 路由：
 *   GET /tasks                     — 列出任务（支持 ?status=&source=&limit= 查询参数）
 *   GET /tasks/:id                 — 获取单个任务详情
 *   GET /tasks/:id/events          — 获取任务事件流（支持 ?since=<seq> 游标）
 *
 * 认证：通过 Bearer token 或 API key header 验证（MVP: 与 /prompt 共享 token）
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join, relative, resolve, sep } from 'node:path'
import type { RouteHandler } from './index.js'
import type { TaskRegistry, NotifyPolicy } from './task-registry.js'
import type { TaskFilter, TaskStatus } from './task-store.js'
import { isAuthorizedRequest } from './auth.js'
import { assertValidTaskId, isValidTaskId } from './task-store.js'
import { errorContext, serverLogger } from './logger.js'

// ─── Query String Parser ──────────────────────────────────────

function parseTaskFilter(query: Record<string, string>): TaskFilter {
  const filter: TaskFilter = {}
  if (query.status) {
    const statuses = query.status.split(',').filter(s => s.length > 0) as TaskStatus[]
    if (statuses.length > 0) filter.status = statuses
  }
  if (query.source) {
    filter.source = query.source as TaskFilter['source']
  }
  if (query.scheduledTaskId) {
    filter.scheduledTaskId = query.scheduledTaskId
  }
  if (query.limit) {
    const n = parseInt(query.limit, 10)
    if (n > 0) filter.limit = n
  }
  return filter
}

// ─── Event Log ────────────────────────────────────────────────

const DEFAULT_EVENTS_DIR = '.rivet/tasks/events'

interface TaskEventLog {
  seq: number
  taskId: string
  type: string
  timestamp: string
  detail?: Record<string, unknown>
}

export interface TaskEventStoreOptions {
  eventsDir?: string
}

/** 写入一条事件到 events.jsonl。seq 以 sidecar 为权威，避免坏尾行导致重置。 */
export function writeTaskEvent(
  taskId: string,
  type: string,
  detail?: Record<string, unknown>,
  options?: TaskEventStoreOptions,
): void {
  try {
    assertValidTaskId(taskId)
    const eventsDir = resolve(options?.eventsDir ?? DEFAULT_EVENTS_DIR)
    mkdirSync(eventsDir, { recursive: true })
    const filePath = pathInside(eventsDir, `${taskId}.jsonl`)
    const seqPath = pathInside(eventsDir, `${taskId}.seq`)
    const seq = nextSeq(seqPath, filePath)
    const event: TaskEventLog = {
      seq,
      taskId,
      type,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    }
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
    writeSeq(seqPath, seq)
  } catch (err) {
    serverLogger.warn('Failed to write task event', { taskId, type, ...errorContext(err) })
  }
}

function nextSeq(seqPath: string, filePath: string): number {
  const sidecarSeq = readSeq(seqPath) ?? 0
  const eventSeq = maxSeqFromEvents(filePath)
  return Math.max(sidecarSeq, eventSeq) + 1
}

function readSeq(seqPath: string): number | null {
  if (!existsSync(seqPath)) return null
  try {
    const n = Number(readFileSync(seqPath, 'utf-8').trim())
    return Number.isInteger(n) && n >= 0 ? n : null
  } catch (err) {
    serverLogger.warn('Failed to read task event seq sidecar', { seqPath, ...errorContext(err) })
    return null
  }
}

function writeSeq(seqPath: string, seq: number): void {
  const tmpPath = `${seqPath}.tmp`
  writeFileSync(tmpPath, `${seq}\n`, 'utf-8')
  renameSync(tmpPath, seqPath)
}

function maxSeqFromEvents(filePath: string): number {
  if (!existsSync(filePath)) return 0
  try {
    const content = readFileSync(filePath, 'utf-8')
    let maxSeq = 0
    for (const line of content.split('\n')) {
      if (line.trim().length === 0) continue
      try {
        const event = JSON.parse(line) as Partial<TaskEventLog>
        if (typeof event.seq === 'number' && Number.isFinite(event.seq)) {
          maxSeq = Math.max(maxSeq, event.seq)
        }
      } catch (err) {
        serverLogger.warn('Skipping corrupt task event line while computing seq', { filePath, ...errorContext(err) })
      }
    }
    return maxSeq
  } catch (err) {
    serverLogger.warn('Failed to scan task event log for seq', { filePath, ...errorContext(err) })
    return 0
  }
}

function readEvents(taskId: string, sinceSeq?: number, options?: TaskEventStoreOptions): TaskEventLog[] {
  if (!isValidTaskId(taskId)) return []
  const eventsDir = resolve(options?.eventsDir ?? DEFAULT_EVENTS_DIR)
  const filePath = pathInside(eventsDir, `${taskId}.jsonl`)
  if (!existsSync(filePath)) return []
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n').filter(l => l.length > 0)
    const events: TaskEventLog[] = []
    for (const line of lines) {
      try {
        const event = JSON.parse(line) as TaskEventLog
        if (sinceSeq === undefined || event.seq > sinceSeq) {
          events.push(event)
        }
      } catch (err) {
        serverLogger.warn('Skipping corrupt task event line', { taskId, ...errorContext(err) })
      }
    }
    return events
  } catch (err) {
    serverLogger.warn('Failed to read task events', { taskId, ...errorContext(err) })
    return []
  }
}

function pathInside(root: string, fileName: string): string {
  const target = resolve(root, fileName)
  const rel = relative(root, target)
  if (rel === '' || rel.startsWith('..') || rel.includes(`..${sep}`) || resolve(target) === root) {
    throw new Error(`Path escapes event directory: ${fileName}`)
  }
  return target
}

// ─── Route Builders ───────────────────────────────────────────

export interface TaskRoutesDeps {
  registry: TaskRegistry
  apiToken?: string
  /** 通知策略，默认 state_changes */
  notifyPolicy?: NotifyPolicy
  /** 测试/嵌入场景可覆盖 events 目录；默认 .rivet/tasks/events */
  eventsDir?: string
}

const unauthorized = () => ({ status: 401, body: { error: 'Unauthorized' } })

export function buildTaskRoutes(deps: TaskRoutesDeps): Record<string, RouteHandler> {
  const { registry, apiToken, notifyPolicy, eventsDir } = deps

  // 事件订阅：TaskRegistry 状态变化 → 按策略写 events.jsonl
  if (notifyPolicy) {
    registry.setNotifyPolicy(notifyPolicy)
  }
  registry.setEventCallback((event) => {
    writeTaskEvent(event.taskId, event.type, undefined, { eventsDir })
  })

  return {
    'GET /tasks': async (body, _params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()

      // createRouter 当前只把 body 传给 handler；测试与调用方可把 query 参数放 body 中。
      const filter = body && typeof body === 'object'
        ? parseTaskFilter(body as Record<string, string>)
        : {}

      const tasks = await registry.listTasks(filter)
      return { status: 200, body: { tasks, count: tasks.length } }
    },

    'GET /tasks/:id': async (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()

      const id = params?.id
      if (!id || !isValidTaskId(id)) return { status: 400, body: { error: 'Invalid task id' } }

      const task = await registry.getTask(id)
      if (!task) return { status: 404, body: { error: 'Task not found' } }

      return { status: 200, body: { task } }
    },

    'POST /tasks/:id/cancel': async (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()

      const id = params?.id
      if (!id || !isValidTaskId(id)) return { status: 400, body: { error: 'Invalid task id' } }

      const cancelled = await registry.cancel(id)
      if (!cancelled) return { status: 404, body: { error: 'Task not found' } }

      return { status: 200, body: { task: cancelled } }
    },

    'GET /tasks/:id/events': async (body, params, headers) => {
      if (!isAuthorizedRequest({ body, headers }, apiToken)) return unauthorized()

      const id = params?.id
      if (!id || !isValidTaskId(id)) return { status: 400, body: { error: 'Invalid task id' } }

      const task = await registry.getTask(id)
      if (!task) return { status: 404, body: { error: 'Task not found' } }

      let sinceSeq: number | undefined
      if (body && typeof body === 'object' && 'since' in body) {
        const s = Number((body as Record<string, unknown>).since)
        if (!isNaN(s) && s >= 0) sinceSeq = s
      }

      const events = readEvents(id, sinceSeq, { eventsDir })
      return { status: 200, body: { events, count: events.length } }
    },
  }
}
