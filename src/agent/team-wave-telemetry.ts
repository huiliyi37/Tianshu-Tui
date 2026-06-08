import { createHash } from 'node:crypto'
import type { CoordinatorRun } from './coordinator.js'
import { matchDomain } from './star-domain.js'
import type { TeamTask } from './team-plan.js'
import type { TeamWave } from './team-grouping.js'

export type ChangedFilesSource = 'worker_result' | 'diff_artifact' | 'unknown'

export interface TeamWaveTelemetry {
  schemaVersion: 1
  sessionId: string
  objectiveHash: string
  mode: 'standard' | 'max'
  fromWave: number
  waveId: string
  waveCount: number
  timestamp: number
  planned: {
    taskIds: string[]
    risk: 'low' | 'medium' | 'high'
    profiles: string[]
    authorities: string[]
    files: string[]
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
    changedFilesSource: ChangedFilesSource
  }
  workerModels?: Array<{ workOrderId: string; model: string }>
  workerModelTierShadows?: Array<{ workOrderId: string; recommendedTier: string; actualTier: string; matched: boolean; reason: string }>
}

export interface TeamWaveTelemetryStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildTeamWaveTelemetryInput {
  sessionId: string
  objective: string
  mode: 'standard' | 'max'
  fromWave: number
  wave: TeamWave
  waves: TeamWave[]
  taskMap: Map<string, TeamTask>
  run: CoordinatorRun
  dispatched?: number
  timestamp?: number
}

export function hashTeamObjective(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 16)
}

export function teamWaveTelemetryKind(event: Pick<TeamWaveTelemetry, 'objectiveHash' | 'sessionId' | 'fromWave' | 'timestamp'>): string {
  return `team_wave:${event.objectiveHash}:${event.sessionId}:${event.fromWave}:${event.timestamp}`
}

function uniqueSorted(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))].sort()
}

export function extractObservedChangedFilesFromArtifacts(run: CoordinatorRun): string[] {
  const files = new Set<string>()
  for (const result of run.results) {
    for (const artifact of result.artifacts) {
      if (artifact.kind !== 'diff') continue
      for (const match of artifact.content.matchAll(/^\+\+\+ b\/(.+)$/gm)) {
        if (match[1]) files.add(match[1])
      }
    }
  }
  return [...files].sort()
}

export function extractReportedChangedFiles(run: CoordinatorRun): string[] {
  return uniqueSorted(run.results.flatMap(result => result.changedFiles))
}

export function buildTeamWaveTelemetry(input: BuildTeamWaveTelemetryInput): TeamWaveTelemetry {
  const tasks = input.wave.taskIds
    .map(id => input.taskMap.get(id))
    .filter((task): task is TeamTask => Boolean(task))
  const reportedChangedFiles = extractReportedChangedFiles(input.run)
  const observedChangedFiles = extractObservedChangedFilesFromArtifacts(input.run)
  const changedFilesSource: ChangedFilesSource = observedChangedFiles.length > 0
    ? 'diff_artifact'
    : reportedChangedFiles.length > 0
      ? 'worker_result'
      : 'unknown'
  const verificationStates = input.run.results
    .map(result => result.verification?.status)
    .filter((status): status is 'passed' | 'failed' | 'blocked' => Boolean(status))
  const verificationPassed = verificationStates.length > 0
    ? verificationStates.every(status => status === 'passed')
    : undefined

  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objectiveHash: hashTeamObjective(input.objective),
    mode: input.mode,
    fromWave: input.fromWave,
    waveId: input.wave.id,
    waveCount: input.waves.length,
    timestamp: input.timestamp ?? Date.now(),
    planned: {
      taskIds: [...input.wave.taskIds],
      risk: input.wave.risk,
      profiles: uniqueSorted(tasks.map(task => task.profile)),
      authorities: uniqueSorted(tasks.map(task => taskAuthority(task))),
      files: uniqueSorted(tasks.flatMap(task => task.touchSet.length > 0 ? task.touchSet : task.files)),
    },
    outcome: {
      dispatched: input.dispatched ?? input.run.results.length,
      statuses: input.run.results.map(result => ({
        workOrderId: result.workOrderId,
        status: result.status,
        evidenceStatus: result.evidenceStatus,
      })),
      ...(verificationPassed === undefined ? {} : { verificationPassed }),
    },
    changedFiles: {
      ...(reportedChangedFiles.length > 0 ? { reportedChangedFiles } : {}),
      ...(observedChangedFiles.length > 0 ? { observedChangedFiles } : {}),
      changedFilesSource,
    },
    ...(input.run.workerModels && input.run.workerModels.length > 0
      ? { workerModels: input.run.workerModels.map(model => ({ ...model })) }
      : {}),
    ...(input.run.modelTierShadows && input.run.modelTierShadows.length > 0
      ? {
          workerModelTierShadows: input.run.modelTierShadows.map(event => ({
            workOrderId: event.workOrderId,
            recommendedTier: event.recommendedTier,
            actualTier: event.actualTier,
            matched: event.matched,
            reason: event.reason,
          })),
        }
      : {}),
  }
}

function taskAuthority(task: TeamTask): string {
  if (task.profile === 'patcher') return 'tianliang'
  if (task.profile === 'reviewer' || task.profile === 'adversarial_verifier') return 'tianquan'
  return matchDomain(task.objective) ?? 'tianliang'
}

export function persistTeamWaveTelemetry(
  store: TeamWaveTelemetryStore | undefined | null,
  event: TeamWaveTelemetry,
): void {
  if (!store) return
  try {
    store.saveBanditState(teamWaveTelemetryKind(event), JSON.stringify(event))
  } catch {
    // Team telemetry must never affect orchestration.
  }
}
