/**
 * Wave Checkpoint — persist team wave state so failed waves can resume.
 *
 * After each wave completes, the team orchestrator calls `saveCheckpoint`.
 * On failure, the user can call `/team resume <groupId>` to re-dispatch
 * from the last completed wave instead of starting over.
 *
 * Checkpoints are stored in `.rivet/checkpoints/<groupId>.json` and contain:
 * - completed wave results
 * - remaining task definitions
 * - wave index to resume from
 */

import { writeFileSync, readFileSync, existsSync, mkdirSync, unlinkSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import type { WorkerResult, WorkOrder } from './work-order.js'

const CHECKPOINT_DIR = '.rivet/checkpoints'

export interface WaveCheckpoint {
  /** Team group identifier (from team_orchestrate groupId). */
  groupId: string
  /** Timestamp of checkpoint creation. */
  timestamp: number
  /** Index of the last completed wave (0-based). Resume starts at +1. */
  lastCompletedWave: number
  /** Results from all completed waves. */
  completedResults: WorkerResult[]
  /** Remaining tasks not yet dispatched. */
  remainingOrders: Array<Pick<WorkOrder, 'id' | 'objective' | 'profile' | 'kind' | 'scope' | 'authority'>>
  /** Original objective for context. */
  objective: string
  /** Total waves planned. */
  totalWaves: number
}

function getCheckpointPath(cwd: string, groupId: string): string {
  return join(cwd, CHECKPOINT_DIR, `${groupId}.json`)
}

/** Save a wave checkpoint to disk. Overwrites any existing checkpoint for the group. */
export function saveCheckpoint(cwd: string, checkpoint: WaveCheckpoint): void {
  const dir = join(cwd, CHECKPOINT_DIR)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(getCheckpointPath(cwd, checkpoint.groupId), JSON.stringify(checkpoint, null, 2), 'utf-8')
}

/** Load the latest checkpoint for a group. Returns null if none exists. */
export function loadCheckpoint(cwd: string, groupId: string): WaveCheckpoint | null {
  const path = getCheckpointPath(cwd, groupId)
  if (!existsSync(path)) return null
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as WaveCheckpoint
  } catch {
    return null
  }
}

/** Delete a checkpoint after successful completion (no need to keep it). */
export function clearCheckpoint(cwd: string, groupId: string): void {
  const path = getCheckpointPath(cwd, groupId)
  if (existsSync(path)) unlinkSync(path)
}

/** List all available checkpoints for display. */
export function listCheckpoints(cwd: string): Array<{ groupId: string; wave: number; totalWaves: number; timestamp: number }> {
  const dir = join(cwd, CHECKPOINT_DIR)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f: string) => f.endsWith('.json'))
    .map((f: string) => {
      try {
        const cp = JSON.parse(readFileSync(join(dir, f), 'utf-8')) as WaveCheckpoint
        return { groupId: cp.groupId, wave: cp.lastCompletedWave, totalWaves: cp.totalWaves, timestamp: cp.timestamp }
      } catch {
        return null
      }
    })
    .filter((x: unknown): x is { groupId: string; wave: number; totalWaves: number; timestamp: number } => x !== null)
    .sort((a: { timestamp: number }, b: { timestamp: number }) => b.timestamp - a.timestamp)
}

/** Format checkpoint list for display. */
export function formatCheckpointList(checkpoints: Array<{ groupId: string; wave: number; totalWaves: number; timestamp: number }>): string {
  if (checkpoints.length === 0) return 'No checkpoints available.'
  const lines = ['Available checkpoints:', '']
  for (const cp of checkpoints) {
    const age = Math.round((Date.now() - cp.timestamp) / 1000)
    const ageStr = age < 60 ? `${age}s ago` : age < 3600 ? `${Math.round(age / 60)}m ago` : `${Math.round(age / 3600)}h ago`
    lines.push(`  ${cp.groupId} — wave ${cp.wave + 1}/${cp.totalWaves} (${ageStr})`)
  }
  lines.push('', 'Use: /team resume <groupId> to resume from checkpoint.')
  return lines.join('\n')
}
