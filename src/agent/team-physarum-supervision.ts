import { createHash } from 'node:crypto'
import type { TeamEpisode, TeamEpisodeFragment } from './team-episode.js'
import { buildTeamEpisodeScopeHealth, type TeamScopeHealthSeverity } from './team-scope-health.js'
import { isIndexablePhysarumFile } from '../repo/physarum-engine.js'

// ── Types ────────────────────────────────────────────────────────────────────

export interface TeamPhysarumSupervisionEdge {
  fromFile: string
  toFile: string
  relation: 'cross_wave' | 'explicit_dependency'
  fromWaveId: string
  toWaveId: string
  sourceTaskIds: string[]
  targetTaskIds: string[]
  dtTurns: number
}

export interface TeamPhysarumSupervisionEvent {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  episodeKey: string
  applied: boolean
  safeToApply: boolean
  edges: TeamPhysarumSupervisionEdge[]
  skipped: Array<{ reason: string; detail: string }>
  scopeSeverity: TeamScopeHealthSeverity
  timestamp: number
}

export interface TeamPhysarumSupervisionStore {
  saveBanditState(kind: string, json: string): void
}

/**
 * Per-task file mapping for explicit_dependency edge construction.
 *
 * Key = task id (matching TeamWaveTelemetry.planned.taskIds).
 * Values = actual changed files for that specific task.
 *
 * When not provided, only cross_wave edges are built.
 */
export type TaskFileMap = Map<string, string[]>

// ── Helpers ──────────────────────────────────────────────────────────────────

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

/** Resolve actual changed files for a fragment — prefer observed diff, fall back to reported. */
function actualFilesForFragment(fragment: TeamEpisodeFragment): { files: string[]; isReportedFallback: boolean } {
  const observed = uniqueSorted(fragment.telemetry.changedFiles.observedChangedFiles ?? [])
  if (observed.length > 0) return { files: observed, isReportedFallback: false }
  const reported = uniqueSorted(fragment.telemetry.changedFiles.reportedChangedFiles ?? [])
  return { files: reported, isReportedFallback: true }
}

// ── Safety gates ─────────────────────────────────────────────────────────────

interface SafetyResult {
  safeToApply: boolean
  shadowOnly: boolean
  skipped: Array<{ reason: string; detail: string }>
}

function checkSafety(episode: TeamEpisode): SafetyResult {
  const skipped: Array<{ reason: string; detail: string }> = []

  if (!episode.complete) {
    skipped.push({ reason: 'episode_incomplete', detail: `episode ${episode.episodeKey} is not complete` })
    return { safeToApply: false, shadowOnly: true, skipped }
  }

  const failedOrBlocked = episode.outcome.statuses.filter(
    s => s.status === 'failed' || s.status === 'blocked' || s.evidenceStatus === 'failed'
  )
  if (failedOrBlocked.length > 0) {
    skipped.push({
      reason: 'failed_or_blocked_status',
      detail: `${failedOrBlocked.length} status(es) are failed/blocked/failed-evidence`,
    })
    return { safeToApply: false, shadowOnly: true, skipped }
  }

  const scopeHealth = buildTeamEpisodeScopeHealth(episode)
  if (scopeHealth.severity === 'high') {
    skipped.push({
      reason: 'high_scope_leak',
      detail: `scope severity ${scopeHealth.severity}, leaked ${scopeHealth.leakedFiles.length} files`,
    })
    return { safeToApply: false, shadowOnly: true, skipped }
  }

  // Actual files must be non-empty for at least one fragment
  const hasActualFiles = episode.fragments.some(f => actualFilesForFragment(f).files.length > 0)
  if (!hasActualFiles) {
    skipped.push({ reason: 'no_actual_files', detail: 'no fragment has observed or reported changed files' })
    return { safeToApply: false, shadowOnly: true, skipped }
  }

  // Spec §4.1: reported-only fallback with non-healthy/low scope → shadow-only
  const anyReportedOnly = episode.fragments.some(f => actualFilesForFragment(f).isReportedFallback)
  if (anyReportedOnly && scopeHealth.severity !== 'healthy' && scopeHealth.severity !== 'low') {
    skipped.push({
      reason: 'reported_fallback_non_healthy',
      detail: `scope severity ${scopeHealth.severity} with reported-only changed files — shadow-only per §4.1`,
    })
    return { safeToApply: false, shadowOnly: true, skipped }
  }

  return { safeToApply: true, shadowOnly: false, skipped }
}

// ── Edge construction ────────────────────────────────────────────────────────

interface EdgeBuildResult {
  edges: TeamPhysarumSupervisionEdge[]
  skipped: Array<{ reason: string; detail: string }>
}

function buildCrossWaveEdges(episode: TeamEpisode): EdgeBuildResult {
  const edges: TeamPhysarumSupervisionEdge[] = []
  const skipped: Array<{ reason: string; detail: string }> = []

  const ordered = [...episode.fragments].sort((a, b) =>
    a.telemetry.fromWave - b.telemetry.fromWave
  )

  for (let i = 0; i < ordered.length - 1; i++) {
    const prev = ordered[i]!
    const next = ordered[i + 1]!

    if (prev.telemetry.fromWave === next.telemetry.fromWave) {
      skipped.push({
        reason: 'parallel_wave_no_order',
        detail: `wave ${prev.telemetry.fromWave} fragments are parallel, cannot determine order`,
      })
      continue
    }

    const prevFiles = actualFilesForFragment(prev)
    const nextFiles = actualFilesForFragment(next)

    // Record reported-fallback reason for telemetry (§4.1)
    if (prevFiles.isReportedFallback) {
      skipped.push({
        reason: 'reported_files_fallback',
        detail: `wave ${prev.telemetry.fromWave}: using worker-reported files (no observed diff)`,
      })
    }
    if (nextFiles.isReportedFallback) {
      skipped.push({
        reason: 'reported_files_fallback',
        detail: `wave ${next.telemetry.fromWave}: using worker-reported files (no observed diff)`,
      })
    }

    if (prevFiles.files.length === 0 || nextFiles.files.length === 0) {
      skipped.push({
        reason: 'empty_actual_files',
        detail: `wave ${prev.telemetry.fromWave}→${next.telemetry.fromWave}: one side has no actual files`,
      })
      continue
    }

    const fromFiles = prevFiles.files.filter(isIndexablePhysarumFile)
    const toFiles = nextFiles.files.filter(isIndexablePhysarumFile)
    if (fromFiles.length === 0 || toFiles.length === 0) {
      skipped.push({
        reason: 'no_indexable_files',
        detail: `wave ${prev.telemetry.fromWave}→${next.telemetry.fromWave}: all files filtered by isIndexablePhysarumFile`,
      })
      continue
    }

    for (const fromFile of fromFiles) {
      for (const toFile of toFiles) {
        edges.push({
          fromFile,
          toFile,
          relation: 'cross_wave',
          fromWaveId: String(prev.telemetry.fromWave),
          toWaveId: String(next.telemetry.fromWave),
          sourceTaskIds: prev.telemetry.planned.taskIds,
          targetTaskIds: next.telemetry.planned.taskIds,
          dtTurns: next.telemetry.fromWave - prev.telemetry.fromWave,
        })
      }
    }
  }

  return { edges, skipped }
}

/**
 * Build explicit_dependency edges from task-level dependsOn relationships.
 *
 * When a task in a later wave depends on a task in an earlier wave,
 * we connect their actual changed files with direction.
 *
 * Requires task→files mapping and task-level dependsOn info.
 */
function buildExplicitDependencyEdges(
  episode: TeamEpisode,
  taskFiles: TaskFileMap,
  taskDependsOn: Map<string, string[]>,
): EdgeBuildResult {
  const edges: TeamPhysarumSupervisionEdge[] = []
  const skipped: Array<{ reason: string; detail: string }> = []

  // Build task→wave lookup
  const taskWave = new Map<string, number>()
  for (const fragment of episode.fragments) {
    for (const taskId of fragment.telemetry.planned.taskIds) {
      taskWave.set(taskId, fragment.telemetry.fromWave)
    }
  }

  // Build completed task set
  const completedTasks = new Set<string>()
  for (const fragment of episode.fragments) {
    for (const status of fragment.telemetry.outcome.statuses) {
      if (status.status === 'completed' && status.evidenceStatus === 'passed') {
        const taskId = status.workOrderId.startsWith('task:')
          ? status.workOrderId.slice(5)
          : status.workOrderId
        completedTasks.add(taskId)
      }
    }
    if (fragment.telemetry.outcome.verificationPassed) {
      for (const taskId of fragment.telemetry.planned.taskIds) {
        completedTasks.add(taskId)
      }
    }
  }

  for (const [taskId, deps] of taskDependsOn) {
    const taskWaveId = taskWave.get(taskId)
    const taskActualFiles = uniqueSorted(taskFiles.get(taskId) ?? [])
    // NB: wave index 0 is falsy — use === undefined, not !taskWaveId
    if (taskWaveId === undefined || taskActualFiles.length === 0) continue

    for (const depId of deps) {
      const depWaveId = taskWave.get(depId)
      const depActualFiles = uniqueSorted(taskFiles.get(depId) ?? [])
      if (depWaveId === undefined || depActualFiles.length === 0) continue

      // Both tasks must be completed
      if (!completedTasks.has(taskId) || !completedTasks.has(depId)) {
        skipped.push({
          reason: 'dependency_task_not_completed',
          detail: `${depId}→${taskId}: one or both tasks not completed`,
        })
        continue
      }

      // Only cross-wave dependencies: dep must be in an earlier wave
      if (depWaveId >= taskWaveId) {
        skipped.push({
          reason: 'dependency_not_cross_wave',
          detail: `${depId}→${taskId}: dependency is within same or later wave`,
        })
        continue
      }

      const fromFiles = depActualFiles.filter(isIndexablePhysarumFile)
      const toFiles = taskActualFiles.filter(isIndexablePhysarumFile)
      if (fromFiles.length === 0 || toFiles.length === 0) {
        skipped.push({
          reason: 'dependency_no_indexable_files',
          detail: `${depId}→${taskId}: all files filtered by isIndexablePhysarumFile`,
        })
        continue
      }

      for (const fromFile of fromFiles) {
        for (const toFile of toFiles) {
          edges.push({
            fromFile,
            toFile,
            relation: 'explicit_dependency',
            fromWaveId: String(depWaveId),
            toWaveId: String(taskWaveId),
            sourceTaskIds: [depId],
            targetTaskIds: [taskId],
            dtTurns: Math.max(1, taskWaveId - depWaveId),
          })
        }
      }
    }
  }

  return { edges, skipped }
}

// ── Public API ───────────────────────────────────────────────────────────────

export interface BuildOptions {
  timestamp?: number
  apply?: boolean
  /** Per-task actual changed files for explicit_dependency edges. Overrides telemetry-derived facts. */
  taskFiles?: TaskFileMap
  /** Task-level dependsOn: key = task id, values = task ids this task depends on. Overrides telemetry-derived facts. */
  taskDependsOn?: Map<string, string[]>
}

function deriveTaskFilesFromEpisode(episode: TeamEpisode): TaskFileMap {
  const taskFiles: TaskFileMap = new Map()
  for (const fragment of episode.fragments) {
    const observedByTask = fragment.telemetry.changedFiles.observedChangedFilesByTask ?? []
    const reportedByTask = fragment.telemetry.changedFiles.reportedChangedFilesByTask ?? []
    const reported = new Map(reportedByTask.map(entry => [entry.taskId, entry.files]))
    const taskIds = new Set([...observedByTask.map(entry => entry.taskId), ...reportedByTask.map(entry => entry.taskId)])
    for (const taskId of taskIds) {
      const observed = observedByTask.find(entry => entry.taskId === taskId)?.files ?? []
      const files = observed.length > 0 ? observed : (reported.get(taskId) ?? [])
      if (files.length > 0) taskFiles.set(taskId, uniqueSorted(files))
    }
  }
  return taskFiles
}

function deriveTaskDependsOnFromEpisode(episode: TeamEpisode): Map<string, string[]> {
  const taskDependsOn = new Map<string, string[]>()
  for (const fragment of episode.fragments) {
    for (const entry of fragment.telemetry.planned.taskDependencies ?? []) {
      if (entry.dependsOn.length > 0) taskDependsOn.set(entry.taskId, uniqueSorted(entry.dependsOn))
    }
  }
  return taskDependsOn
}

/**
 * Build physarum supervision edges from a completed TeamEpisode.
 *
 * Defaults to shadow-only (applied=false). Caller sets apply=true only when
 * the supervision event passes all safety gates and should be written into
 * the physarum engine.
 */
export function buildTeamPhysarumSupervision(
  episode: TeamEpisode,
  options: BuildOptions = {},
): TeamPhysarumSupervisionEvent {
  const scopeHealth = buildTeamEpisodeScopeHealth(episode)
  const safety = checkSafety(episode)

  let allEdges: TeamPhysarumSupervisionEdge[] = []
  let allSkipped = [...safety.skipped]

  if (safety.safeToApply) {
    const crossWave = buildCrossWaveEdges(episode)
    allEdges = crossWave.edges
    allSkipped = allSkipped.concat(crossWave.skipped)

    // explicit_dependency edges: prefer caller-supplied facts, otherwise derive from TeamWaveTelemetry.
    const taskFiles = options.taskFiles ?? deriveTaskFilesFromEpisode(episode)
    const taskDependsOn = options.taskDependsOn ?? deriveTaskDependsOnFromEpisode(episode)
    if (taskFiles.size > 0 && taskDependsOn.size > 0) {
      const depEdges = buildExplicitDependencyEdges(episode, taskFiles, taskDependsOn)
      allEdges = allEdges.concat(depEdges.edges)
      allSkipped = allSkipped.concat(depEdges.skipped)
    }
  }

  return {
    schemaVersion: 1,
    sessionId: episode.sessionId,
    objectiveHash: episode.objectiveHash,
    episodeKey: episode.episodeKey,
    applied: options.apply ?? false,
    safeToApply: safety.safeToApply,
    edges: allEdges,
    skipped: allSkipped,
    scopeSeverity: scopeHealth.severity,
    timestamp: options.timestamp ?? Date.now(),
  }
}

/**
 * Apply supervision edges into the physarum engine.
 *
 * Guards: event must be marked applied AND safeToApply AND have edges.
 * Call order: recordFlow before recordSequentialEdit (per spec §2.3).
 */
export function applyTeamPhysarumSupervision(
  engine: { recordFlow(fileA: string, fileB: string, turn: number): void; recordSequentialEdit(first: string, second: string, dtTurns: number): void },
  event: TeamPhysarumSupervisionEvent,
  startTurn = 1,
): void {
  if (!event.applied || !event.safeToApply || event.edges.length === 0) return

  for (const edge of event.edges) {
    // recordFlow first, then recordSequentialEdit (spec §2.3)
    engine.recordFlow(edge.fromFile, edge.toFile, startTurn)
    engine.recordSequentialEdit(edge.fromFile, edge.toFile, Math.max(1, edge.dtTurns))
  }
}

export function teamPhysarumSupervisionPersistKind(event: TeamPhysarumSupervisionEvent): string {
  const edgeSeed = event.edges.map(e => `${e.fromFile}|${e.toFile}`).join(',')
  return `team_physarum_supervision:${event.objectiveHash}:${event.sessionId}:${event.timestamp}:${shortHash(edgeSeed)}`
}

export function persistTeamPhysarumSupervision(
  store: TeamPhysarumSupervisionStore | undefined | null,
  event: TeamPhysarumSupervisionEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(teamPhysarumSupervisionPersistKind(event), JSON.stringify(event))
  } catch {
    // Physarum supervision telemetry must never affect team scheduling or reward.
  }
}
