// Pure helpers for the automations dashboard: group task execution records by
// their ScheduledTask and summarize the latest run. Kept pure + total so they
// are unit-testable without a running backend.

import i18n from '../i18n'
import type { TaskRecord, TaskStatus } from '../runtime/types'

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
