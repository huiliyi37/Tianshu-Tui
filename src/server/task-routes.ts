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

import type { RouteHandler } from './index.js'
import type { TaskRegistry, NotifyPolicy } from './task-registry.js'
import type { TaskFilter, TaskStatus } from './task-store.js'
import { timingSafeEqual } from 'node:crypto'

// ─── Auth ─────────────────────────────────────────────────────

function extractToken(_body: unknown, headers?: Record<string, string>): string | null {
  // Authorization: Bearer <token> header（优先）
  const authHeader = headers?.['authorization']
  if (authHeader && authHeader.startsWith('Bearer ')) {
    return authHeader.slice(7)
  }
  // fallback: body-based token（POST 兼容）
  if (_body && typeof _body === 'object' && 'token' in _body) {
    return String((_body as Record<string, unknown>).token)
  }
  return null
}

function checkAuth(token: string | null, expectedToken?: string): boolean {
  // 未配置 token → 拒绝所有请求（fail-closed）
  if (!expectedToken) return false
  if (!token) return false
  // 长度不同直接拒绝（避免 timingSafeEqual 抛异常）
  if (token.length !== expectedToken.length) return false
  return timingSafeEqual(
    Buffer.from(token),
    Buffer.from(expectedToken),
  )
}

// ─── Query String Parser ──────────────────────────────────────

function parseQuery(path: string): Record<string, string> {
  const qIndex = path.indexOf('?')
  if (qIndex === -1) return {}
  const qs = path.slice(qIndex + 1)
  const params: Record<string, string> = {}
  for (const pair of qs.split('&')) {
    const [k, v] = pair.split('=')
    if (k) params[decodeURIComponent(k)] = decodeURIComponent(v ?? '')
  }
  return params
}

function parseTaskFilter(query: Record<string, string>): TaskFilter {
  const filter: TaskFilter = {}
  if (query.status) {
    const statuses = query.status.split(',').filter(s => s.length > 0) as TaskStatus[]
    if (statuses.length > 0) filter.status = statuses
  }
  if (query.source) {
    filter.source = query.source as TaskFilter['source']
  }
  if (query.limit) {
    const n = parseInt(query.limit, 10)
    if (n > 0) filter.limit = n
  }
  return filter
}

// ─── Event Log ────────────────────────────────────────────────

import { appendFileSync, existsSync, readFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

const DEFAULT_EVENTS_DIR = '.rivet/tasks/events'

interface TaskEventLog {
  seq: number
  taskId: string
  type: string
  timestamp: string
  detail?: Record<string, unknown>
}

/** 写入一条事件到 events.jsonl */
export function writeTaskEvent(taskId: string, type: string, detail?: Record<string, unknown>): void {
  try {
    mkdirSync(DEFAULT_EVENTS_DIR, { recursive: true })
    const filePath = join(DEFAULT_EVENTS_DIR, `${taskId}.jsonl`)
    const seq = nextSeq(filePath)
    const event: TaskEventLog = {
      seq,
      taskId,
      type,
      timestamp: new Date().toISOString(),
      ...(detail ? { detail } : {}),
    }
    appendFileSync(filePath, JSON.stringify(event) + '\n', 'utf-8')
  } catch {
    // 事件写入失败不影响主流程
  }
}

function nextSeq(filePath: string): number {
  if (!existsSync(filePath)) return 1
  try {
    const content = readFileSync(filePath, 'utf-8')
    const lines = content.trim().split('\n')
    if (lines.length === 0) return 1
    const lastLine = lines[lines.length - 1]
    if (!lastLine) return 1
    const lastEvent = JSON.parse(lastLine) as TaskEventLog
    return (lastEvent.seq ?? 0) + 1
  } catch {
    return 1
  }
}

function readEvents(taskId: string, sinceSeq?: number): TaskEventLog[] {
  const filePath = join(DEFAULT_EVENTS_DIR, `${taskId}.jsonl`)
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
      } catch {
        // 损坏行跳过
      }
    }
    return events
  } catch {
    return []
  }
}

// ─── Route Builders ───────────────────────────────────────────

export interface TaskRoutesDeps {
  registry: TaskRegistry
  apiToken?: string
  /** 通知策略，默认 state_changes */
  notifyPolicy?: NotifyPolicy
}

export function buildTaskRoutes(deps: TaskRoutesDeps): Record<string, RouteHandler> {
  const { registry, apiToken, notifyPolicy } = deps

  // 事件订阅：TaskRegistry 状态变化 → 按策略写 events.jsonl
  if (notifyPolicy) {
    registry.setNotifyPolicy(notifyPolicy)
  }
  registry.setEventCallback((event) => {
    writeTaskEvent(event.taskId, event.type)
  })

  return {
    'GET /tasks': async (body, _params, headers) => {
      const token = extractToken(body, headers)
      if (!checkAuth(token, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }

      // 从 query string 解析过滤条件
      // Note: params 从 router 传入，但 query 在 path 中
      // 我们通过 body 的 _query 或在 handler 内无法直接取到 path
      // Workaround: body 可携带查询参数
      const filter = body && typeof body === 'object'
        ? parseTaskFilter(body as Record<string, string>)
        : {}

      const tasks = await registry.listTasks(filter)
      return { status: 200, body: { tasks, count: tasks.length } }
    },

    'GET /tasks/:id': async (body, params, headers) => {
      const token = extractToken(body, headers)
      if (!checkAuth(token, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }

      const id = params?.id
      if (!id) return { status: 400, body: { error: 'Missing task id' } }

      const task = await registry.getTask(id)
      if (!task) return { status: 404, body: { error: 'Task not found' } }

      return { status: 200, body: { task } }
    },

    'POST /tasks/:id/cancel': async (body, params, headers) => {
      const token = extractToken(body, headers)
      if (!checkAuth(token, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }

      const id = params?.id
      if (!id) return { status: 400, body: { error: 'Missing task id' } }

      const cancelled = await registry.cancel(id)
      if (!cancelled) return { status: 404, body: { error: 'Task not found' } }

      return { status: 200, body: { task: cancelled } }
    },

    'GET /tasks/:id/events': async (body, params, headers) => {
      const token = extractToken(body, headers)
      if (!checkAuth(token, apiToken)) {
        return { status: 401, body: { error: 'Unauthorized' } }
      }

      const id = params?.id
      if (!id) return { status: 400, body: { error: 'Missing task id' } }

      // 检查任务是否存在
      const task = await registry.getTask(id)
      if (!task) return { status: 404, body: { error: 'Task not found' } }

      // 解析 since 游标（从 body 获取）
      let sinceSeq: number | undefined
      if (body && typeof body === 'object' && 'since' in body) {
        const s = Number((body as Record<string, unknown>).since)
        if (!isNaN(s) && s >= 0) sinceSeq = s
      }

      const events = readEvents(id, sinceSeq)
      return { status: 200, body: { events, count: events.length } }
    },
  }
}
