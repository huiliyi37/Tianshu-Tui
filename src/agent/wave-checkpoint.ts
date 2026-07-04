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
import { createHash } from 'node:crypto'
import type { WorkerResult, WorkOrder } from './work-order.js'
import { serializeUnifiedPlan, type UnifiedPlan } from './unified-plan.js'

const CHECKPOINT_DIR = '.rivet/checkpoints'

/**
 * Deterministic team group id from the objective. Multi-wave runs call
 * team_orchestrate once per wave with the same objective, so hashing the
 * objective maps all waves of one run to a single checkpoint file.
 */
export function deriveTeamGroupId(objective: string): string {
  const hash = createHash('sha1').update(objective.trim()).digest('hex').slice(0, 8)
  return `team-${hash}`
}

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

/**
 * A2 (/team-resume): turn a checkpoint into a resumable plan + kickoff prompt.
 *
 * The remaining orders become a fresh UnifiedPlan (the resumed run re-groups
 * waves from wave 0 over the remaining tasks), which the caller stores via
 * plan-store so a bare `team_orchestrate` call auto-consumes it. Returns null
 * when there is nothing left to dispatch (e.g. the final wave failed — rerun
 * that wave manually instead).
 */
export function buildResumeFromCheckpoint(cp: WaveCheckpoint): { planJson: string; prompt: string } | null {
  if (cp.remainingOrders.length === 0) return null
  const plan: UnifiedPlan = {
    version: 1,
    objective: cp.objective,
    tasks: cp.remainingOrders.map(order => ({
      id: order.id,
      title: order.id,
      objective: order.objective,
      profile: order.profile,
      kind: order.kind,
      files: order.scope.files ?? [],
      dependsOn: [],
      riskTier: 'medium' as const,
    })),
    source: 'team_orchestrate',
    createdAt: Date.now(),
  }
  const completed = cp.completedResults
  const failed = completed.filter(r => r.status !== 'passed')
  const doneLines = [
    `已完成 ${cp.lastCompletedWave + 1}/${cp.totalWaves} 波（${completed.length} 个 worker，${failed.length} 个未通过）。`,
    ...failed.slice(0, 3).map(r => `  ✗ ${r.workOrderId}: ${r.summary.slice(0, 120)}`),
  ]
  const prompt = [
    `[TEAM RESUME] 从 checkpoint ${cp.groupId} 续跑团队任务。`,
    '',
    `Objective: ${cp.objective}`,
    doneLines.join('\n'),
    '',
    `剩余 ${cp.remainingOrders.length} 个任务已重组为计划并存入会话（plan-store）。`,
    `直接调用 team_orchestrate({ objective: ${JSON.stringify(cp.objective)} })（不要传 planJson/planMarkdown——存储的计划会被自动消费，波次从剩余任务重新分组）。`,
    failed.length > 0 ? '注意：先检查上面未通过的 worker 是否需要先修复其遗留，再派发剩余任务。' : '',
  ].filter(Boolean).join('\n')
  return { planJson: serializeUnifiedPlan(plan), prompt }
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
