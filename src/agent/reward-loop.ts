import { createHash } from 'node:crypto'
import type { ModelRoutingShadowEvent } from './model-routing-shadow.js'
import { routingShadowKind } from './model-routing-shadow.js'
import type { TeamWaveTelemetry } from './team-wave-telemetry.js'
import { teamWaveTelemetryKind } from './team-wave-telemetry.js'
import type { TeamEpisode } from './team-episode.js'
import { buildTeamEpisode, deriveTeamEpisodeRewardInput, persistTeamEpisode, teamEpisodeKey } from './team-episode.js'
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

// Per-session monotonic clock. Append-only reward-closure keys embed
// (sessionId, timestamp), so two closures in the same session within the same
// millisecond would collide. Keyed by sessionId so parallel sessions never
// perturb each other's sequence — previously a single module-level counter let
// one session bump another's timestamp (cross-session drift on a shared cwd).
const MAX_TRACKED_SESSIONS = 512
const lastTimestampBySession = new Map<string, number>()

function shortHash(input: string): string {
  return createHash('sha256').update(input).digest('hex').slice(0, 8)
}

function resolveRewardClosureTimestamp(sessionId: string, explicitTimestamp: number | undefined): number {
  const last = lastTimestampBySession.get(sessionId) ?? 0
  let next: number
  if (explicitTimestamp !== undefined) {
    next = explicitTimestamp
    lastTimestampBySession.set(sessionId, Math.max(last, explicitTimestamp))
  } else {
    const now = Date.now()
    next = now > last ? now : last + 1
    lastTimestampBySession.set(sessionId, next)
  }
  // Bound growth in long-running multi-session servers (insertion-order evict).
  if (lastTimestampBySession.size > MAX_TRACKED_SESSIONS) {
    const oldest = lastTimestampBySession.keys().next().value
    if (oldest !== undefined) lastTimestampBySession.delete(oldest)
  }
  return next
}

/** Test-only: reset the per-session monotonic clock between cases. */
export function resetRewardClosureClock(): void {
  lastTimestampBySession.clear()
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
  const timestamp = resolveRewardClosureTimestamp(input.sessionId, input.timestamp)
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

export interface TeamEpisodeClosureStore {
  saveBanditState?(kind: string, json: string): void
  loadBanditStatesByPrefix?(prefix: string, limit?: number): Array<{ kind: string; json: string }>
}

function parseWaveFragment(json: string): TeamWaveTelemetry | null {
  try {
    const parsed = JSON.parse(json) as TeamWaveTelemetry
    if (parsed?.schemaVersion !== 1 || typeof parsed.fromWave !== 'number') return null
    return parsed
  } catch {
    return null
  }
}

/**
 * Track 2 episode 闭环：以最后一波的（已带 reviewVerdict 的）遥测为锚，从
 * append-only 存储里捞回同 objective+session 的全部 wave 片段，聚合成
 * episode 并落 episode 级 reward closure。
 *
 * - 同一 fromWave 的重复片段（同 objective 重跑）只保留最新时间戳的那条，
 *   避免 duplicateWaveIndexes 误判 episode 不完整。
 * - episode 不完整（缺波）→ 不产出 reward（deriveTeamEpisodeRewardInput
 *   返回 null），但 episode 本体仍持久化以便诊断。
 */
export function recordTeamEpisodeClosureFromStore(
  store: TeamEpisodeClosureStore | undefined | null,
  lastFragment: TeamWaveTelemetry,
): RewardClosureRecord | null {
  const byWave = new Map<number, TeamWaveTelemetry>()
  if (store?.loadBanditStatesByPrefix) {
    const prefix = `team_wave:${lastFragment.objectiveHash}:${lastFragment.sessionId}:`
    try {
      for (const row of store.loadBanditStatesByPrefix(prefix, 200)) {
        const fragment = parseWaveFragment(row.json)
        if (!fragment) continue
        if (fragment.mode !== lastFragment.mode || fragment.waveCount !== lastFragment.waveCount) continue
        const existing = byWave.get(fragment.fromWave)
        if (!existing || fragment.timestamp > existing.timestamp) byWave.set(fragment.fromWave, fragment)
      }
    } catch {
      // Fall through to the anchor-only episode below.
    }
  }
  // The anchor fragment carries the final reviewVerdict — it wins its wave slot.
  byWave.set(lastFragment.fromWave, lastFragment)

  const episode = buildTeamEpisode([...byWave.values()])
  const persistStore = store?.saveBanditState ? { saveBanditState: store.saveBanditState.bind(store) } : null
  persistTeamEpisode(persistStore, episode)
  return recordTeamEpisodeRewardClosure(persistStore, episode)
}
