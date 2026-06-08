import { createHash } from 'node:crypto'
import type { ModelRoutingShadowEvent } from './model-routing-shadow.js'
import { routingShadowKind } from './model-routing-shadow.js'
import type { TeamWaveTelemetry } from './team-wave-telemetry.js'
import { teamWaveTelemetryKind } from './team-wave-telemetry.js'
import type { TeamEpisode } from './team-episode.js'
import { deriveTeamEpisodeRewardInput, teamEpisodeKey } from './team-episode.js'
import { buildRoutingRewardRecord, type RoutingRewardInput } from './routing-reward.js'
import { buildTeamWaveRewardRecord, deriveTeamWaveRewardInput } from './team-reward.js'

export type RewardSourceKind = 'routing_shadow' | 'team_wave' | 'team_episode'

export interface RewardClosureRecord {
  schemaVersion: 1
  id: string
  sourceKind: RewardSourceKind
  sourceKey: string
  objectiveHash?: string
  sessionId: string
  reward: number
  components: Record<string, number | boolean | string>
  timestamp: number
}

export interface RewardClosureStore {
  saveBanditState(kind: string, json: string): void
}

export interface BuildRewardClosureOptions {
  timestamp?: number
}

let lastRewardClosureTimestamp = 0

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function resolveRewardClosureTimestamp(explicitTimestamp: number | undefined): number {
  if (explicitTimestamp !== undefined) {
    lastRewardClosureTimestamp = Math.max(lastRewardClosureTimestamp, explicitTimestamp)
    return explicitTimestamp
  }
  const now = Date.now()
  const next = now > lastRewardClosureTimestamp ? now : lastRewardClosureTimestamp + 1
  lastRewardClosureTimestamp = next
  return next
}

function rewardClosureHashSeed(record: Pick<RewardClosureRecord, 'sourceKind' | 'sourceKey' | 'timestamp'>): string {
  return `${record.sourceKind}:${record.sourceKey}:${record.timestamp}`
}

export function rewardClosureKind(record: Pick<RewardClosureRecord, 'sourceKind' | 'sourceKey' | 'sessionId' | 'timestamp'>): string {
  return `reward_closure:${record.sourceKind}:${record.sessionId}:${record.timestamp}:${shortHash(rewardClosureHashSeed(record))}`
}

function buildRewardClosureRecord(input: {
  sourceKind: RewardSourceKind
  sourceKey: string
  objectiveHash?: string
  sessionId: string
  reward: number
  components: Record<string, number | boolean | string>
  timestamp?: number
}): RewardClosureRecord {
  const timestamp = resolveRewardClosureTimestamp(input.timestamp)
  const id = `${input.sourceKind}:${input.sourceKey}:${timestamp}:${shortHash(`${input.sourceKind}:${input.sourceKey}:${timestamp}`)}`
  return {
    schemaVersion: 1,
    id,
    sourceKind: input.sourceKind,
    sourceKey: input.sourceKey,
    ...(input.objectiveHash ? { objectiveHash: input.objectiveHash } : {}),
    sessionId: input.sessionId,
    reward: input.reward,
    components: input.components,
    timestamp,
  }
}

function routingRewardInputFromEvent(event: ModelRoutingShadowEvent): RoutingRewardInput {
  return {
    currentModel: event.currentModel,
    recommendedModel: event.efeRecommendedModel ?? event.legacyRouterRecommendedModel,
    normalizedCostOverBudget: 0,
    normalizedLatencySurprisal: 0,
  }
}

export function buildRewardClosureRecordFromRoutingShadow(
  event: ModelRoutingShadowEvent,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord {
  const rewardInput = routingRewardInputFromEvent(event)
  const rewardRecord = buildRoutingRewardRecord(rewardInput)
  return buildRewardClosureRecord({
    sourceKind: 'routing_shadow',
    sourceKey: routingShadowKind(event),
    objectiveHash: event.objectiveHash,
    sessionId: event.sessionId,
    reward: rewardRecord.reward,
    components: {
      ...rewardRecord.components,
      turn: event.turn,
      selectedBy: event.selectedBy,
      sensoriumComplexity: event.sensorium.complexity,
      sensoriumPressure: event.sensorium.pressure,
      sensoriumConfidence: event.sensorium.confidence,
      sensoriumStability: event.sensorium.stability,
    },
    timestamp: options?.timestamp,
  })
}

export function buildRewardClosureRecordFromTeamWave(
  event: TeamWaveTelemetry,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord {
  const rewardInput = deriveTeamWaveRewardInput(event)
  const rewardRecord = buildTeamWaveRewardRecord(rewardInput)
  return buildRewardClosureRecord({
    sourceKind: 'team_wave',
    sourceKey: teamWaveTelemetryKind(event),
    objectiveHash: event.objectiveHash,
    sessionId: event.sessionId,
    reward: rewardRecord.reward,
    components: {
      ...rewardRecord.components,
      mode: event.mode,
      fromWave: event.fromWave,
      waveId: event.waveId,
      waveCount: event.waveCount,
      dispatched: event.outcome.dispatched,
      ...(event.outcome.reviewVerdict ? { reviewVerdict: event.outcome.reviewVerdict } : {}),
      changedFilesSource: event.changedFiles.changedFilesSource,
      workerModelCount: event.workerModels?.length ?? 0,
      tierShadowCount: event.workerModelTierShadows?.length ?? 0,
      tierShadowMatchedCount: event.workerModelTierShadows?.filter(shadow => shadow.matched).length ?? 0,
      ...(event.workerModels?.length === 1 ? { workerModel: event.workerModels[0]!.model } : {}),
    },
    timestamp: options?.timestamp,
  })
}

export function buildRewardClosureRecordFromTeamEpisode(
  episode: TeamEpisode,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord | null {
  const rewardInput = deriveTeamEpisodeRewardInput(episode)
  if (!rewardInput) return null
  const rewardRecord = buildTeamWaveRewardRecord(rewardInput)
  return buildRewardClosureRecord({
    sourceKind: 'team_episode',
    sourceKey: teamEpisodeKey(episode),
    objectiveHash: episode.objectiveHash,
    sessionId: episode.sessionId,
    reward: rewardRecord.reward,
    components: {
      ...rewardRecord.components,
      mode: episode.mode,
      waveCount: episode.waveCount,
      observedWaveCount: episode.observedWaveIndexes.length,
      dispatched: episode.outcome.dispatched,
      ...(episode.outcome.reviewVerdict ? { reviewVerdict: episode.outcome.reviewVerdict } : {}),
      changedFilesSource: episode.changedFiles.changedFilesSource,
      fragmentCount: episode.fragments.length,
      maxRisk: episode.planned.maxRisk,
    },
    timestamp: options?.timestamp,
  })
}

export function persistRewardClosure(
  store: RewardClosureStore | undefined | null,
  record: RewardClosureRecord,
): void {
  if (!store) return
  try {
    store.saveBanditState(rewardClosureKind(record), JSON.stringify(record))
  } catch {
    // Reward closure telemetry must never affect routing or team dispatch.
  }
}

export function recordRoutingRewardClosure(
  store: RewardClosureStore | undefined | null,
  event: ModelRoutingShadowEvent,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord {
  const record = buildRewardClosureRecordFromRoutingShadow(event, options)
  persistRewardClosure(store, record)
  return record
}

export function recordTeamWaveRewardClosure(
  store: RewardClosureStore | undefined | null,
  event: TeamWaveTelemetry,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord {
  const record = buildRewardClosureRecordFromTeamWave(event, options)
  persistRewardClosure(store, record)
  return record
}

export function recordTeamEpisodeRewardClosure(
  store: RewardClosureStore | undefined | null,
  episode: TeamEpisode,
  options?: BuildRewardClosureOptions,
): RewardClosureRecord | null {
  const record = buildRewardClosureRecordFromTeamEpisode(episode, options)
  if (!record) return null
  persistRewardClosure(store, record)
  return record
}
