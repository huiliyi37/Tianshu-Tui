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
  skipped: Array<{ reason: string; detail: string }>
}

function checkSafety(episode: TeamEpisode): SafetyResult {
  const skipped: Array<{ reason: string; detail: string }> = []

  if (!episode.complete) {
    skipped.push({ reason: 'episode_incomplete', detail: `episode ${episode.episodeKey} is not complete` })
    return { safeToApply: false, skipped }
  }

  const failedOrBlocked = episode.outcome.statuses.filter(
    s => s.status === 'failed' || s.status === 'blocked' || s.evidenceStatus === 'failed'
  )
  if (failedOrBlocked.length > 0) {
    skipped.push({
      reason: 'failed_or_blocked_status',
      detail: `${failedOrBlocked.length} status(es) are failed/blocked/failed-evidence`,
    })
    return { safeToApply: false, skipped }
  }

  const scopeHealth = buildTeamEpisodeScopeHealth(episode)
  if (scopeHealth.severity === 'high') {
    skipped.push({
      reason: 'high_scope_leak',
      detail: `scope severity ${scopeHealth.severity}, leaked ${scopeHealth.leakedFiles.length} files`,
    })
    return { safeToApply: false, skipped }
  }

  // Actual files must be non-empty for at least one fragment
  const hasActualFiles = episode.fragments.some(f => actualFilesForFragment(f).files.length > 0)
  if (!hasActualFiles) {
    skipped.push({ reason: 'no_actual_files', detail: 'no fragment has observed or reported changed files' })
    return { safeToApply: false, skipped }
  }

  return { safeToApply: true, skipped }
}

// ── Edge construction ────────────────────────────────────────────────────────

function buildCrossWaveEdges(episode: TeamEpisode, scopeSeverity: TeamScopeHealthSeverity): {
  edges: TeamPhysarumSupervisionEdge[]
  skipped: Array<{ reason: string; detail: string }>
} {
  const edges: TeamPhysarumSupervisionEdge[] = []
  const skipped: Array<{ reason: string; detail: string }> = []

  // Sort fragments by fromWave for ordering
  const ordered = [...episode.fragments].sort((a, b) =>
    a.telemetry.fromWave - b.telemetry.fromWave
  )

  for (let i = 0; i < ordered.length - 1; i++) {
    const prev = ordered[i]!
    const next = ordered[i + 1]!

    // Only cross-wave if fromWave differs
    if (prev.telemetry.fromWave === next.telemetry.fromWave) {
      skipped.push({
        reason: 'parallel_wave_no_order',
        detail: `wave ${prev.telemetry.fromWave} fragments are parallel, cannot determine order`,
      })
      continue
    }

    const prevFiles = actualFilesForFragment(prev)
    const nextFiles = actualFilesForFragment(next)

    if (prevFiles.files.length === 0 || nextFiles.files.length === 0) {
      skipped.push({
        reason: 'empty_actual_files',
        detail: `wave ${prev.telemetry.fromWave}→${next.telemetry.fromWave}: one side has no actual files`,
      })
      continue
    }

    // Only produce edges for indexable files
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

// ── Public API ───────────────────────────────────────────────────────────────

/**
 * Build physarum supervision edges from a completed TeamEpisode.
 *
 * Defaults to shadow-only (applied=false). Caller sets apply=true only when
 * the supervision event passes all safety gates and should be written into
 * the physarum engine.
 */
export function buildTeamPhysarumSupervision(
  episode: TeamEpisode,
  options: { timestamp?: number; apply?: boolean } = {},
): TeamPhysarumSupervisionEvent {
  const scopeHealth = buildTeamEpisodeScopeHealth(episode)
  const safety = checkSafety(episode)

  let allEdges: TeamPhysarumSupervisionEdge[] = []
  let allSkipped = [...safety.skipped]

  if (safety.safeToApply) {
    const crossWave = buildCrossWaveEdges(episode, scopeHealth.severity)
    allEdges = crossWave.edges
    allSkipped = allSkipped.concat(crossWave.skipped)
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
 * Call order: recordFlow before recordSequentialEdit (per spec).
 * Only safeToApply events should be passed here.
 */
export function applyTeamPhysarumSupervision(
  engine: { recordFlow(fileA: string, fileB: string, turn: number): void; recordSequentialEdit(first: string, second: string, dtTurns: number): void },
  event: TeamPhysarumSupervisionEvent,
  startTurn = 1,
): void {
  if (!event.safeToApply || event.edges.length === 0) return

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
