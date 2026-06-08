import { createHash } from 'node:crypto'
import type { TeamEpisode } from './team-episode.js'
import type { ChangedFilesSource, TeamWaveTelemetry } from './team-wave-telemetry.js'
import { teamWaveTelemetryKind } from './team-wave-telemetry.js'

export type TeamScopeHealthSourceKind = 'team_wave' | 'team_episode'
export type TeamScopeHealthSeverity = 'healthy' | 'low' | 'medium' | 'high'
export type TeamScopeHealthChangedFilesSource = ChangedFilesSource | 'mixed'

export interface TeamScopeHealth {
  schemaVersion: 1
  sourceKind: TeamScopeHealthSourceKind
  sourceKey: string
  sessionId: string
  objectiveHash: string
  plannedFiles: string[]
  actualFiles: string[]
  coveredFiles: string[]
  leakedFiles: string[]
  missingFiles: string[]
  changedFilesSource: TeamScopeHealthChangedFilesSource
  scopeLeakRate: number
  coverageRate: number
  severity: TeamScopeHealthSeverity
  reasons: string[]
  timestamp: number
}

export interface TeamScopeHealthStore {
  saveBanditState(kind: string, json: string): void
}

interface ScopeHealthInput {
  sourceKind: TeamScopeHealthSourceKind
  sourceKey: string
  sessionId: string
  objectiveHash: string
  plannedFiles: string[]
  reportedChangedFiles?: string[]
  observedChangedFiles?: string[]
  changedFilesSource: TeamScopeHealthChangedFilesSource
  timestamp: number
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function selectActualFiles(input: Pick<ScopeHealthInput, 'observedChangedFiles' | 'reportedChangedFiles' | 'changedFilesSource'>): { actualFiles: string[]; source: TeamScopeHealthChangedFilesSource; reason: string } {
  const observed = uniqueSorted(input.observedChangedFiles ?? [])
  if (observed.length > 0) return { actualFiles: observed, source: 'diff_artifact', reason: 'actual_files_from_observed_diff' }

  const reported = uniqueSorted(input.reportedChangedFiles ?? [])
  if (reported.length > 0) return { actualFiles: reported, source: 'worker_result', reason: 'actual_files_from_worker_report' }

  return { actualFiles: [], source: input.changedFilesSource === 'mixed' ? 'mixed' : 'unknown', reason: 'no_actual_files_observed' }
}

export function isHighRiskScopePath(file: string): boolean {
  const normalized = file.replace(/\\/g, '/')
  return /(^|\/)(package-lock\.json|package\.json|tsconfig\.json|\.env(?:\..*)?|schema|schemas|migration|migrations|prompt|prompts|security|auth|config)(\/|$|\.)/.test(normalized)
}

function computeSeverity(input: {
  plannedFiles: string[]
  actualFiles: string[]
  leakedFiles: string[]
  missingFiles: string[]
  reasons: string[]
}): TeamScopeHealthSeverity {
  if (input.actualFiles.length === 0) {
    input.reasons.push('no_actual_files_observed')
    return 'healthy'
  }
  if (input.plannedFiles.length === 0) {
    input.reasons.push('actual_files_without_planned_scope')
    return 'high'
  }
  if (input.leakedFiles.some(isHighRiskScopePath)) {
    input.reasons.push('high_risk_scope_leak')
    return 'high'
  }
  if (input.leakedFiles.length > 0) {
    input.reasons.push('scope_leak_detected')
    return 'medium'
  }
  if (input.missingFiles.length > 0) {
    input.reasons.push('planned_files_not_observed')
    return 'low'
  }
  input.reasons.push('scope_healthy')
  return 'healthy'
}

function buildTeamScopeHealth(input: ScopeHealthInput): TeamScopeHealth {
  const plannedFiles = uniqueSorted(input.plannedFiles)
  const plannedSet = new Set(plannedFiles)
  const selected = selectActualFiles(input)
  const actualFiles = selected.actualFiles
  const actualSet = new Set(actualFiles)
  const coveredFiles = actualFiles.filter(file => plannedSet.has(file))
  const leakedFiles = actualFiles.filter(file => !plannedSet.has(file))
  const missingFiles = plannedFiles.filter(file => !actualSet.has(file))
  const reasons = [selected.reason]
  const severity = computeSeverity({ plannedFiles, actualFiles, leakedFiles, missingFiles, reasons })

  return {
    schemaVersion: 1,
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
    sessionId: input.sessionId,
    objectiveHash: input.objectiveHash,
    plannedFiles,
    actualFiles,
    coveredFiles,
    leakedFiles,
    missingFiles,
    changedFilesSource: selected.source,
    scopeLeakRate: actualFiles.length === 0 ? 0 : leakedFiles.length / actualFiles.length,
    coverageRate: plannedFiles.length === 0 ? 0 : coveredFiles.length / plannedFiles.length,
    severity,
    reasons: uniqueSorted(reasons),
    timestamp: input.timestamp,
  }
}

export function buildTeamWaveScopeHealth(event: TeamWaveTelemetry, options: { timestamp?: number } = {}): TeamScopeHealth {
  return buildTeamScopeHealth({
    sourceKind: 'team_wave',
    sourceKey: teamWaveTelemetryKind(event),
    sessionId: event.sessionId,
    objectiveHash: event.objectiveHash,
    plannedFiles: event.planned.files,
    reportedChangedFiles: event.changedFiles.reportedChangedFiles,
    observedChangedFiles: event.changedFiles.observedChangedFiles,
    changedFilesSource: event.changedFiles.changedFilesSource,
    timestamp: options.timestamp ?? event.timestamp,
  })
}

export function buildTeamEpisodeScopeHealth(episode: TeamEpisode, options: { timestamp?: number } = {}): TeamScopeHealth {
  return buildTeamScopeHealth({
    sourceKind: 'team_episode',
    sourceKey: episode.episodeKey,
    sessionId: episode.sessionId,
    objectiveHash: episode.objectiveHash,
    plannedFiles: episode.planned.files,
    reportedChangedFiles: episode.changedFiles.reportedChangedFiles,
    observedChangedFiles: episode.changedFiles.observedChangedFiles,
    changedFilesSource: episode.changedFiles.changedFilesSource,
    timestamp: options.timestamp ?? episode.timestamp,
  })
}

export function teamScopeHealthPersistKind(event: TeamScopeHealth): string {
  const sourceSeed = `${event.sourceKey}:${event.actualFiles.join('|')}:${event.plannedFiles.join('|')}`
  return `team_scope_health:${event.objectiveHash}:${event.sessionId}:${event.sourceKind}:${event.timestamp}:${shortHash(sourceSeed)}`
}

export function persistTeamScopeHealth(store: TeamScopeHealthStore | undefined | null, event: TeamScopeHealth): void {
  if (!store) return
  try {
    store.saveBanditState(teamScopeHealthPersistKind(event), JSON.stringify(event))
  } catch {
    // Scope health telemetry must never affect reward or dispatch.
  }
}
