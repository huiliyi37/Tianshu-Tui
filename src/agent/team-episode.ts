import { createHash } from 'node:crypto'
import type { TeamWaveRewardInput } from './team-reward.js'
import { deriveTeamWaveRewardInput } from './team-reward.js'
import type { TeamWaveTelemetry, ChangedFilesSource } from './team-wave-telemetry.js'
import { teamWaveTelemetryKind } from './team-wave-telemetry.js'
import { normalizeUnitPenalty } from './routing-reward.js'
import { buildTeamEpisodeScopeHealth } from './team-scope-health.js'

export interface TeamEpisodeFragment {
  sourceKey: string
  telemetry: TeamWaveTelemetry
}

export interface TeamEpisode {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  mode: 'standard' | 'max'
  episodeKey: string
  complete: boolean
  waveCount: number
  observedWaveIndexes: number[]
  missingWaveIndexes: number[]
  duplicateWaveIndexes: number[]
  fragments: TeamEpisodeFragment[]
  planned: {
    taskIds: string[]
    files: string[]
    profiles: string[]
    authorities: string[]
    maxRisk: 'low' | 'medium' | 'high'
  }
  outcome: {
    dispatched: number
    statuses: Array<{ workOrderId: string; status: string; evidenceStatus: string }>
    verificationPassed?: boolean
    reviewVerdict?: string
  }
  changedFiles: {
    reportedChangedFiles?: string[]
    observedChangedFiles?: string[]
    changedFilesSource: ChangedFilesSource | 'mixed'
  }
  mismatchReasons: string[]
  timestamp: number
}

export interface TeamEpisodeStore {
  saveBanditState(kind: string, json: string): void
}

export function teamEpisodeKey(input: Pick<TeamEpisode, 'objectiveHash' | 'sessionId' | 'mode' | 'waveCount'>): string {
  return `team_episode:${input.objectiveHash}:${input.sessionId}:${input.mode}:${input.waveCount}`
}

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

export function teamEpisodePersistKind(episode: TeamEpisode): string {
  const sourceSeed = episode.fragments.map(fragment => fragment.sourceKey).join('|')
  return `${episode.episodeKey}:${episode.timestamp}:${shortHash(sourceSeed)}`
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

function riskRank(risk: 'low' | 'medium' | 'high'): number {
  return risk === 'high' ? 2 : risk === 'medium' ? 1 : 0
}

function maxRisk(values: Array<'low' | 'medium' | 'high'>): 'low' | 'medium' | 'high' {
  return values.reduce((max, value) => riskRank(value) > riskRank(max) ? value : max, 'low' as const)
}

function duplicateIndexes(indexes: number[]): number[] {
  const counts = new Map<number, number>()
  for (const index of indexes) counts.set(index, (counts.get(index) ?? 0) + 1)
  return [...counts.entries()].filter(([, count]) => count > 1).map(([index]) => index).sort((a, b) => a - b)
}

function missingIndexes(indexes: number[], waveCount: number): number[] {
  const observed = new Set(indexes)
  const missing: number[] = []
  for (let index = 0; index < waveCount; index++) {
    if (!observed.has(index)) missing.push(index)
  }
  return missing
}

function aggregateVerification(values: Array<boolean | undefined>): boolean | undefined {
  if (values.some(value => value === false)) return false
  const observed = values.filter(value => value !== undefined)
  if (observed.length > 0 && observed.length === values.length && observed.every(Boolean)) return true
  return undefined
}

function normalizeReviewVerdict(verdict: string | undefined): boolean | undefined {
  if (!verdict) return undefined
  const normalized = verdict.trim().toLowerCase().replace(/[\s_-]+/g, '-')
  if (!normalized) return undefined
  if (['pass', 'passed', 'verified', 'approve', 'approved', 'ok', 'clean', 'green', 'no-findings'].includes(normalized)) return true
  if (['fail', 'failed', 'rejected', 'reject', 'blocked', 'changes-requested', 'red'].includes(normalized)) return false
  return undefined
}

function aggregateReviewVerdict(values: Array<string | undefined>): { pass?: boolean; verdict?: string } {
  const normalized = values.map(normalizeReviewVerdict)
  if (normalized.some(value => value === false)) return { pass: false, verdict: 'fail' }
  const observed = normalized.filter(value => value !== undefined)
  if (observed.length > 0 && observed.length === values.length && observed.every(Boolean)) return { pass: true, verdict: 'pass' }
  return {}
}

function aggregateChangedFilesSource(sources: Array<ChangedFilesSource>): ChangedFilesSource | 'mixed' {
  const unique = uniqueSorted(sources)
  if (unique.length === 0) return 'unknown'
  if (unique.length === 1) return unique[0] as ChangedFilesSource
  return 'mixed'
}

export function buildTeamEpisode(fragments: TeamWaveTelemetry[], options: { timestamp?: number } = {}): TeamEpisode {
  if (fragments.length === 0) throw new Error('buildTeamEpisode requires at least one fragment')

  const first = fragments[0]!
  const mismatchReasons: string[] = []
  for (const fragment of fragments) {
    if (fragment.sessionId !== first.sessionId) mismatchReasons.push(`sessionId mismatch: ${fragment.sessionId}`)
    if (fragment.objectiveHash !== first.objectiveHash) mismatchReasons.push(`objectiveHash mismatch: ${fragment.objectiveHash}`)
    if (fragment.mode !== first.mode) mismatchReasons.push(`mode mismatch: ${fragment.mode}`)
    if (fragment.waveCount !== first.waveCount) mismatchReasons.push(`waveCount mismatch: ${fragment.waveCount}`)
  }

  const ordered = [...fragments].sort((a, b) => a.fromWave - b.fromWave || a.timestamp - b.timestamp)
  const observedWaveIndexes = uniqueSorted(ordered.map(fragment => String(fragment.fromWave))).map(Number).sort((a, b) => a - b)
  const duplicateWaveIndexes = duplicateIndexes(ordered.map(fragment => fragment.fromWave))
  const missingWaveIndexes = missingIndexes(observedWaveIndexes, first.waveCount)
  const complete = mismatchReasons.length === 0 &&
    duplicateWaveIndexes.length === 0 &&
    missingWaveIndexes.length === 0 &&
    observedWaveIndexes.length === first.waveCount

  const review = aggregateReviewVerdict(ordered.map(fragment => fragment.outcome.reviewVerdict))
  const observedChangedFiles = uniqueSorted(ordered.flatMap(fragment => fragment.changedFiles.observedChangedFiles ?? []))
  const reportedChangedFiles = uniqueSorted(ordered.flatMap(fragment => fragment.changedFiles.reportedChangedFiles ?? []))

  const episode: TeamEpisode = {
    schemaVersion: 1,
    sessionId: first.sessionId,
    objectiveHash: first.objectiveHash,
    mode: first.mode,
    episodeKey: teamEpisodeKey({ objectiveHash: first.objectiveHash, sessionId: first.sessionId, mode: first.mode, waveCount: first.waveCount }),
    complete,
    waveCount: first.waveCount,
    observedWaveIndexes,
    missingWaveIndexes,
    duplicateWaveIndexes,
    fragments: ordered.map(telemetry => ({ sourceKey: teamWaveTelemetryKind(telemetry), telemetry })),
    planned: {
      taskIds: uniqueSorted(ordered.flatMap(fragment => fragment.planned.taskIds)),
      files: uniqueSorted(ordered.flatMap(fragment => fragment.planned.files)),
      profiles: uniqueSorted(ordered.flatMap(fragment => fragment.planned.profiles)),
      authorities: uniqueSorted(ordered.flatMap(fragment => fragment.planned.authorities)),
      maxRisk: maxRisk(ordered.map(fragment => fragment.planned.risk)),
    },
    outcome: {
      dispatched: ordered.reduce((sum, fragment) => sum + fragment.outcome.dispatched, 0),
      statuses: ordered.flatMap(fragment => fragment.outcome.statuses.map(status => ({ ...status }))),
      ...(aggregateVerification(ordered.map(fragment => fragment.outcome.verificationPassed)) === undefined
        ? {}
        : { verificationPassed: aggregateVerification(ordered.map(fragment => fragment.outcome.verificationPassed))! }),
      ...(review.verdict ? { reviewVerdict: review.verdict } : {}),
    },
    changedFiles: {
      ...(reportedChangedFiles.length > 0 ? { reportedChangedFiles } : {}),
      ...(observedChangedFiles.length > 0 ? { observedChangedFiles } : {}),
      changedFilesSource: aggregateChangedFilesSource(ordered.map(fragment => fragment.changedFiles.changedFilesSource)),
    },
    mismatchReasons: uniqueSorted(mismatchReasons),
    timestamp: options.timestamp ?? Math.max(...ordered.map(fragment => fragment.timestamp)),
  }

  return episode
}

export function deriveTeamEpisodeRewardInput(episode: TeamEpisode): TeamWaveRewardInput | null {
  if (!episode.complete) return null

  const denom = Math.max(episode.outcome.dispatched, episode.outcome.statuses.length, 1)
  const blockedOrEscalated = episode.outcome.statuses.filter(status =>
    status.status === 'blocked' || status.status === 'escalated'
  ).length
  const failedOrFailedEvidence = episode.outcome.statuses.filter(status =>
    status.status === 'failed' || status.evidenceStatus === 'failed'
  ).length
  const review = normalizeReviewVerdict(episode.outcome.reviewVerdict)
  const waveInputs = episode.fragments.map(fragment => deriveTeamWaveRewardInput(fragment.telemetry))

  return {
    verificationPass: episode.outcome.verificationPassed,
    reviewPass: review,
    normalizedConflict: normalizeUnitPenalty(blockedOrEscalated / denom),
    normalizedRework: normalizeUnitPenalty(failedOrFailedEvidence / denom),
    normalizedScopeLeak: buildTeamEpisodeScopeHealth(episode).scopeLeakRate,
    normalizedCostOverBudget: 0,
    normalizedLatencySurprisal: 0,
    falseGreen: waveInputs.some(input => input.falseGreen),
  }
}

/** Files changed in more than one wave — surfaced as a conflict/review hotspot. */
function filesTouchedByMultipleWaves(episode: TeamEpisode): string[] {
  const counts = new Map<string, number>()
  for (const fragment of episode.fragments) {
    const files = fragment.telemetry.changedFiles.observedChangedFiles
      ?? fragment.telemetry.changedFiles.reportedChangedFiles
      ?? []
    for (const file of new Set(files.filter(Boolean))) counts.set(file, (counts.get(file) ?? 0) + 1)
  }
  return [...counts.entries()].filter(([, count]) => count > 1).map(([file]) => file).sort()
}

/**
 * 终局跨波交付综合（P2）—— 把一个 episode 的全部 wave 聚合成单一交付报告：
 * 各波任务与通过数、累计 changedFiles、被多波触碰的文件（冲突面）、整体裁决。
 * 纯展示函数，确定性、零模型成本。
 */
export function formatTeamDelivery(episode: TeamEpisode): string {
  const lines: string[] = []
  lines.push(
    `Team delivery synthesis — ${episode.observedWaveIndexes.length}/${episode.waveCount} waves, ` +
    `${episode.outcome.dispatched} workers${episode.complete ? '' : ' (incomplete)'}`
  )

  for (const fragment of episode.fragments) {
    const t = fragment.telemetry
    const statuses = t.outcome.statuses
    const ok = statuses.filter(s => s.status === 'passed' || s.status === 'completed').length
    const total = statuses.length || t.planned.taskIds.length
    const ids = t.planned.taskIds.join(', ') || '—'
    lines.push(`  wave ${t.fromWave + 1}: ${ids} (${ok}/${total} ok)`)
  }

  const changed = episode.changedFiles.observedChangedFiles ?? episode.changedFiles.reportedChangedFiles ?? []
  lines.push(`Changed files (${changed.length}): ${changed.length > 0 ? changed.join(', ') : 'none'}`)

  const conflicts = filesTouchedByMultipleWaves(episode)
  if (conflicts.length > 0) {
    lines.push(`⚠ Files touched by multiple waves (review for conflicts): ${conflicts.join(', ')}`)
  }

  const verification = episode.outcome.verificationPassed
  const verdict = episode.outcome.reviewVerdict
    ?? (verification === true ? 'verified' : verification === false ? 'verification-failed' : 'no-verdict')
  const verifNote = verification !== undefined ? ` verification=${verification ? 'pass' : 'fail'}` : ''
  lines.push(`Overall: review=${verdict}${verifNote}`)

  return lines.join('\n')
}

export function persistTeamEpisode(store: TeamEpisodeStore | undefined | null, episode: TeamEpisode): void {
  if (!store) return
  try {
    store.saveBanditState(teamEpisodePersistKind(episode), JSON.stringify(episode))
  } catch {
    // Episode telemetry must never affect team dispatch or reward closure.
  }
}
