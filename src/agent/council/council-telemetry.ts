// 议事会会诊遥测 —— append-only，落 MeridianDb p3_state（经 saveBanditState）。
// 铁律：唯一 key 含 timestamp，同 objective 多次会诊不互相覆盖
// （saveBanditState 是 ON CONFLICT(kind) UPSERT）。遥测绝不影响会诊。

import type { CouncilPlan } from './council-plan.js'

export interface CouncilTelemetryStore {
  saveBanditState(kind: string, json: string): void
}

export interface CouncilSessionEvent {
  schemaVersion: 1
  sessionId: string
  objective: string
  objectiveHash: string
  seats: string[]
  roundsRun: number
  decisionCount: number
  acceptedCount: number
  rejectedCount: number
  deferredCount: number
  conflictCount: number
  mergedItemCount: number
  convenedAt: number
  timestamp: number
}

/** append-only key —— sessionId + objectiveHash + timestamp 三元唯一。 */
export function councilSessionKey(
  e: Pick<CouncilSessionEvent, 'sessionId' | 'objectiveHash' | 'timestamp'>,
): string {
  return `council_session:${e.sessionId}:${e.objectiveHash}:${e.timestamp}`
}

export function buildCouncilSessionEvent(input: {
  sessionId: string
  plan: CouncilPlan
  timestamp: number
}): CouncilSessionEvent {
  const { plan } = input
  const decisions = plan.aggregate.decisions
  return {
    schemaVersion: 1,
    sessionId: input.sessionId,
    objective: plan.objective,
    objectiveHash: plan.meta.objectiveHash,
    seats: plan.seats,
    roundsRun: plan.meta.round,
    decisionCount: decisions.length,
    acceptedCount: decisions.filter(d => d.verdict === 'accepted').length,
    rejectedCount: decisions.filter(d => d.verdict === 'rejected').length,
    deferredCount: decisions.filter(d => d.verdict === 'deferred').length,
    conflictCount: plan.aggregate.conflicts.length,
    mergedItemCount: plan.aggregate.mergedItems.length,
    convenedAt: plan.meta.convenedAt,
    timestamp: input.timestamp,
  }
}

export function recordCouncilSession(
  store: CouncilTelemetryStore | undefined | null,
  event: CouncilSessionEvent,
): void {
  if (!store) return
  try {
    store.saveBanditState(councilSessionKey(event), JSON.stringify(event))
  } catch {
    // 遥测绝不影响会诊。
  }
}
