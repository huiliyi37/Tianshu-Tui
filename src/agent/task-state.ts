import type { TrajectoryEntry } from './trajectory.js'

export interface TaskState {
  completed: string[]
  current: string
  remaining: string[]
}

const NEXT_STEP_RE = /(?:next|then|after that|i will|step \d|接下来|然后|下一步)[^.。]*(?:[.。]|$)/gi

export function extractTaskState(entries: TrajectoryEntry[], lastModelText: string): TaskState {
  if (entries.length === 0) return { completed: [], current: 'starting', remaining: [] }

  const successful = entries.filter(e => e.status === 'success' || e.status === 'retried-success')
  const completed = successful.slice(-5).map(e => `${e.tool} ${e.target.split('/').pop() ?? e.target}`)

  const lastEntry = entries[entries.length - 1]!
  const current = lastEntry.status === 'failed' || lastEntry.status === 'retried-failed'
    ? `fixing ${lastEntry.errorClass ?? 'error'} in ${lastEntry.target.split('/').pop()}`
    : `${lastEntry.tool} ${lastEntry.target.split('/').pop()}`

  const remaining: string[] = []
  for (const match of lastModelText.matchAll(NEXT_STEP_RE)) {
    remaining.push(match[0].trim().slice(0, 60))
    if (remaining.length >= 3) break
  }

  return { completed, current, remaining }
}
