import type { TrajectoryEntry } from './trajectory.js'

export interface TaskState {
  completed: string[]
  current: string
  remaining: string[]
  /** Key decisions/findings extracted from model text for reflective compaction */
  decisions: string[]
}

const NEXT_STEP_RE = /(?:next|then|after that|i will|step \d|接下来|然后|下一步)[^.。]*(?:[.。]|$)/gi
const DECISION_RE = /(?:I(?:'ll| will) (?:use|go with|choose|pick|implement)|decided to|approach:|strategy:)[^.。]*(?:[.。]|$)/gi
const FINDING_RE = /(?:found that|discovered|the (?:issue|problem|root cause) (?:is|was)|turns out|发现|原因是)[^.。]*(?:[.。]|$)/gi

export function extractTaskState(entries: TrajectoryEntry[], lastModelText: string): TaskState {
  if (entries.length === 0) return { completed: [], current: 'starting', remaining: [], decisions: [] }

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

  const decisions: string[] = []
  for (const match of lastModelText.matchAll(DECISION_RE)) {
    decisions.push(match[0].trim().slice(0, 80))
    if (decisions.length >= 3) break
  }
  for (const match of lastModelText.matchAll(FINDING_RE)) {
    decisions.push(match[0].trim().slice(0, 80))
    if (decisions.length >= 5) break
  }

  return { completed, current, remaining, decisions }
}
