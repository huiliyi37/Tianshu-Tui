/**
 * /schedule routes (N3) — CRUD over the CronScheduler for the desktop's
 * "定时任务" surface. Bearer-gated (fail-closed). A due task fires through
 * CronWiring → TaskRegistry → SessionRuntimePool → a visible session.
 *
 *   POST   /schedule                create (prompt + trigger)
 *   GET    /schedule                list
 *   POST   /schedule/:id/pause      pause/resume ({ enabled })
 *   DELETE /schedule/:id            remove
 */
import type { RouteHandler } from './index.js'
import { isAuthorizedRequest } from './auth.js'
import {
  CronScheduler,
  createScheduledTask,
  normalizeRetry,
  normalizeReviewPolicy,
  type CronTrigger,
  type CronTriggerType,
} from './cron-scheduler.js'

function withAuth(handler: RouteHandler, apiToken?: string): RouteHandler {
  return async (body, params, headers, res) => {
    if (!isAuthorizedRequest({ body, headers }, apiToken)) {
      return { status: 401, body: { error: 'Unauthorized' } }
    }
    return handler(body, params, headers, res)
  }
}

const TRIGGER_TYPES: CronTriggerType[] = ['interval', 'cron', 'oneshot', 'startup', 'app-open', 'file-change', 'git-push', 'focus-change']
/** 事件触发类型——spec 可空（触发时机由事件决定，非时间表达式）。
 *  file-change 的 spec 是监听路径（相对 cwd）；git-push 的 spec 是分支名（空=任意）；其余 spec 空。 */
const EVENT_TRIGGER_TYPES: ReadonlySet<string> = new Set(['startup', 'app-open', 'file-change', 'git-push', 'focus-change'])

export interface ScheduleRouteOptions {
  getStatus?: () => Promise<unknown> | undefined
  /** 付费版 v1 · T5 — unattendedAutomation Pro gate。缺省 = 允许（测试/TUI 软门禁）。 */
  isUnattendedAutomationEnabled?: () => boolean
}

export function buildScheduleRoutes(
  scheduler: CronScheduler,
  apiToken?: string,
  options: ScheduleRouteOptions = {},
): Record<string, RouteHandler> {
  const { getStatus, isUnattendedAutomationEnabled } = options
  return {
    'POST /schedule': withAuth((body) => {
      const data = (body ?? {}) as {
        prompt?: string
        trigger?: { type?: string; spec?: string }
        allowedTools?: string[]
        agentId?: string
        retry?: unknown
        reviewPolicy?: unknown
      }
      if (!data.prompt || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing "prompt"' } }
      }
      const t = data.trigger
      // 事件触发类型（startup/app-open）spec 可空；时间触发类型必须给 spec。
      const isEventTrigger = t?.type && EVENT_TRIGGER_TYPES.has(t.type)
      if (!t || !t.type || !TRIGGER_TYPES.includes(t.type as CronTriggerType)
        || (!isEventTrigger && !t.spec)) {
        return { status: 400, body: { error: 'Invalid "trigger" (need {type, spec})' } }
      }
      if (data.reviewPolicy !== undefined && !normalizeReviewPolicy(data.reviewPolicy)) {
        return { status: 400, body: { error: 'Invalid "reviewPolicy" (always-review | first-runs | auto-proceed)' } }
      }
      const reviewPolicy = normalizeReviewPolicy(data.reviewPolicy)
      const allowedTools = Array.isArray(data.allowedTools) ? data.allowedTools : []
      // Pro gate（fail-closed）：非 always-review 策略、或显式给了 computer_use
      // 白名单的定时任务都属于「无人值守自动化」，需要 Pro。
      const wantsUnattended = (reviewPolicy !== undefined && reviewPolicy !== 'always-review')
        || allowedTools.includes('computer_use')
      if (wantsUnattended && isUnattendedAutomationEnabled && !isUnattendedAutomationEnabled()) {
        return { status: 403, body: { error: 'pro_required', feature: 'unattendedAutomation' } }
      }
      const trigger: CronTrigger = { type: t.type as CronTriggerType, spec: String(t.spec) }
      try {
        const retry = normalizeRetry(data.retry)
        const task = createScheduledTask(
          data.prompt.trim(),
          trigger,
          allowedTools,
          {
            ...(data.agentId ? { agentId: data.agentId } : {}),
            ...(retry ? { retry } : {}),
            ...(reviewPolicy ? { reviewPolicy } : {}),
          },
        )
        scheduler.add(task)
        return { status: 201, body: task }
      } catch (err) {
        return { status: 400, body: { error: (err as Error).message } }
      }
    }, apiToken),

    'GET /schedule': withAuth(() => ({
      status: 200,
      body: { tasks: scheduler.list() },
    }), apiToken),

    // Scheduler health (running? next-tick count) for the automations dashboard.
    'GET /schedule/status': withAuth(async () => {
      const status = getStatus ? await getStatus() : undefined
      return { status: 200, body: { status: status ?? null } }
    }, apiToken),

    // 试跑驱动信任 · Phase 1 — 立即手动触发一次（恒有人值守）。审批卡片
    // 在试跑中弹出即授权采集；试跑计入 triggerCount，与 first-runs 晋级衔接。
    'POST /schedule/:id/run-now': withAuth((_body, params) => {
      const ok = scheduler.runNow(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found or paused' } }
      return { status: 200, body: { id: params!.id!, triggered: true } }
    }, apiToken),

    'POST /schedule/:id/pause': withAuth((body, params) => {
      const data = (body ?? {}) as { enabled?: boolean }
      const enabled = data.enabled === true
      const ok = scheduler.setEnabled(params!.id!, enabled)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found' } }
      return { status: 200, body: { id: params!.id!, enabled } }
    }, apiToken),

    'DELETE /schedule/:id': withAuth((_body, params) => {
      const ok = scheduler.remove(params!.id!)
      if (!ok) return { status: 404, body: { error: 'Scheduled task not found' } }
      return { status: 200, body: { removed: true } }
    }, apiToken),

    // focus-change：前端 Tauri window focus/blur event 命中时调入，fire 所有
    // focus-change 类型任务。不经轮询——纯由前端事件驱动。
    'POST /schedule/trigger-focus': withAuth(() => {
      const fired = scheduler.fireByEvent('focus-change')
      return { status: 200, body: { fired } }
    }, apiToken),
  }
}
