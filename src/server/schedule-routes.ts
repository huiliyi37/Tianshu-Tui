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

const TRIGGER_TYPES: CronTriggerType[] = ['interval', 'cron', 'oneshot']

export function buildScheduleRoutes(
  scheduler: CronScheduler,
  apiToken?: string,
): Record<string, RouteHandler> {
  return {
    'POST /schedule': withAuth((body) => {
      const data = (body ?? {}) as {
        prompt?: string
        trigger?: { type?: string; spec?: string }
        allowedTools?: string[]
        agentId?: string
      }
      if (!data.prompt || !data.prompt.trim()) {
        return { status: 400, body: { error: 'Missing "prompt"' } }
      }
      const t = data.trigger
      if (!t || !t.type || !TRIGGER_TYPES.includes(t.type as CronTriggerType) || !t.spec) {
        return { status: 400, body: { error: 'Invalid "trigger" (need {type, spec})' } }
      }
      const trigger: CronTrigger = { type: t.type as CronTriggerType, spec: String(t.spec) }
      try {
        const task = createScheduledTask(
          data.prompt.trim(),
          trigger,
          Array.isArray(data.allowedTools) ? data.allowedTools : [],
          data.agentId ? { agentId: data.agentId } : undefined,
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
  }
}
