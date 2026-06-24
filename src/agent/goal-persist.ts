/**
 * Goal state persistence — save/load/delete goal state to/from disk.
 *
 * Session recovery: when a session resumes, an `active` goal is automatically
 * downgraded to `paused` (normalizeAfterResume) — the process that wrote
 * `active` is gone, so the user must explicitly resume via /goal-resume.
 */
import { join } from 'path'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { readFileSync, existsSync, unlinkSync } from 'fs'
import type { GoalStateRecord } from './goal-state.js'
import { GoalTracker } from './goal-tracker.js'
import type { GoalTrackerConfig } from './goal-tracker.js'

export function goalStatePath(sessionDir: string, sessionId: string): string {
  return join(sessionDir, `${sessionId}.goal.json`)
}

export function saveGoalState(sessionDir: string, sessionId: string, tracker: GoalTracker): void {
  const record = tracker.toRecord()
  writeFileAtomicSync(goalStatePath(sessionDir, sessionId), JSON.stringify(record, null, 2) + '\n')
}

export function loadGoalState(sessionDir: string, sessionId: string): GoalStateRecord | null {
  const path = goalStatePath(sessionDir, sessionId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as GoalStateRecord
  } catch {
    return null
  }
}

export function deleteGoalState(sessionDir: string, sessionId: string): void {
  const path = goalStatePath(sessionDir, sessionId)
  if (existsSync(path)) {
    unlinkSync(path)
  }
}

/** Restore a goal tracker from disk. active→paused (normalizeAfterResume).
 *  Returns null if no goal file exists or the goal is already complete. */
export function restoreGoalTracker(
  sessionDir: string,
  sessionId: string,
  config: Pick<GoalTrackerConfig, 'maxJudgeRuns'>,
): GoalTracker | null {
  const record = loadGoalState(sessionDir, sessionId)
  if (!record) return null
  if (record.status === 'complete') return null
  // fromRecord internally performs normalizeAfterResume (active→paused)
  return GoalTracker.fromRecord(record, config)
}
