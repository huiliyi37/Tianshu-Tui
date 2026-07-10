// Pure helpers for the automations dashboard: group task execution records by
// their ScheduledTask and summarize the latest run. Kept pure + total so they
// are unit-testable without a running backend.

import i18n from '../i18n'
import type { ScheduledTask, TaskRecord, TaskStatus } from '../runtime/types'

const TERMINAL: ReadonlySet<TaskStatus> = new Set(['completed', 'failed', 'cancelled', 'timed_out'])

/** Runs of a given ScheduledTask, newest first. */
export function tasksForSchedule(tasks: ReadonlyArray<TaskRecord>, scheduledTaskId: string): TaskRecord[] {
  return tasks
    .filter((t) => t.scheduledTaskId === scheduledTaskId)
    .slice()
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
}

/** Status of the most recent run for a schedule, or null if it never ran. */
export function latestStatusForSchedule(
  tasks: ReadonlyArray<TaskRecord>,
  scheduledTaskId: string,
): TaskStatus | null {
  const runs = tasksForSchedule(tasks, scheduledTaskId)
  return runs.length > 0 ? runs[0]!.status : null
}

export function isTerminalStatus(status: TaskStatus): boolean {
  return TERMINAL.has(status)
}

/** Whether a run can be cancelled (still active). */
export function isCancellable(status: TaskStatus): boolean {
  return status === 'pending' || status === 'running'
}

export function statusLabel(status: TaskStatus): string {
  return i18n.t(`automations:status.${status}`, { defaultValue: status })
}

// ── 试跑驱动信任（Phase 2）────────────────────────────────────────────

/** 与 src/server/cron-scheduler.ts 的 FIRST_RUNS_TRUST_THRESHOLD 保持一致。 */
export const FIRST_RUNS_TRUST_THRESHOLD = 3

/**
 * 任务的信任阶段（仅对含无人值守意图的策略有意义）：
 * - untried: first-runs 且从未运行
 * - building: first-runs 且已运行但未达晋级阈值
 * - trusted: first-runs 且已达阈值——后续运行自动放行
 * - unattended: auto-proceed（创建即无人值守）
 * always-review 返回 null（每次都人工审批，没有信任演进可言）。
 */
export type TrustStage = 'untried' | 'building' | 'trusted' | 'unattended'

export function trustStage(
  task: Pick<ScheduledTask, 'reviewPolicy' | 'triggerCount'>,
): TrustStage | null {
  switch (task.reviewPolicy) {
    case 'auto-proceed':
      return 'unattended'
    case 'first-runs':
      if (task.triggerCount <= 0) return 'untried'
      return task.triggerCount >= FIRST_RUNS_TRUST_THRESHOLD ? 'trusted' : 'building'
    default:
      return null
  }
}

/** 授权清单 diff：after 中新出现的 app（试跑后授权 toast 用）。 */
export function newlyGrantedApps(
  before: readonly string[],
  after: readonly string[],
): string[] {
  const prev = new Set(before)
  return after.filter((app) => !prev.has(app))
}

/**
 * 从无人值守中止的会话错误文本里提取缺授权的 app 名（Phase 3 通知文案用）。
 * 会话层只有文本 error（TaskRecord 才有结构化 haltedApp），格式来自
 * src/server/session-manager.ts 的 halt 分支：
 * "unattended run blocked on approval: <tool> (app: <name>)"
 */
const HALT_APP_RE = /unattended run blocked on approval: \S+ \(app: (.+)\)/
export function haltedAppFromError(error: string | undefined): string | null {
  if (!error) return null
  const m = HALT_APP_RE.exec(error)
  return m?.[1] ?? null
}

/** Tone class for a status badge (maps to existing badge color classes). */
export function statusTone(status: TaskStatus): 'green' | 'red' | 'yellow' | 'muted' {
  switch (status) {
    case 'completed': return 'green'
    case 'failed':
    case 'timed_out': return 'red'
    case 'running':
    case 'pending': return 'yellow'
    default: return 'muted'
  }
}
