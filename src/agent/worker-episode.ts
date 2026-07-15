import { createHash } from 'node:crypto'
import type { WorkOrder, WorkerResult } from './work-order.js'
import type { WorkerWriteGateReport } from './worker-write-gate.js'
import type { RoutingRewardInput } from './routing-reward.js'

/**
 * W4-D3: worker episode record — one row per delegated worker run, persisted
 * into the SAME append-only routing-metrics store (saveBanditState) used by
 * routing_shadow / team_wave / team_episode. No new isolated failure ledger.
 *
 * The reward derivation (D2) feeds the existing closure pipeline:
 * producer (write gate, hands-session) → episode → reward closure →
 * buildHistoricalModelRewards → future dispatch ranking (gated: shadow by
 * default, applied only when efeRouting.enabled). Rewards NEVER change the
 * current task's model — dispatch already happened when the episode is built.
 */
export interface WorkerEpisode {
  schemaVersion: 1
  orderId: string
  sessionId: string
  objectiveHash: string
  model: string
  profile?: string
  role: 'hands' | 'brain'
  scopeFileCount: number
  changedFileCount: number
  status: WorkerResult['status']
  evidenceStatus?: WorkerResult['evidenceStatus']
  /** Main-side write gate outcome; 'not-run' when the gate did not execute. */
  gateOutcome: WorkerWriteGateReport['outcome'] | 'not-run'
  /** Worker claimed passed but the main gate failed (heaviest penalty). */
  falseGreen: boolean
  /** Bounded repair rounds consumed (0 or 1). */
  repairCount: number
  timestamp: number
}

function hashObjective(objective: string): string {
  return createHash('sha256').update(objective).digest('hex').slice(0, 12)
}

export function workerEpisodeKey(episode: Pick<WorkerEpisode, 'sessionId' | 'orderId' | 'timestamp'>): string {
  return `worker_episode:${episode.sessionId}:${episode.orderId.replace(/:/g, '-')}:${episode.timestamp}`
}

export interface BuildWorkerEpisodeInput {
  order: WorkOrder
  result: WorkerResult
  sessionId: string
  model: string
  role: 'hands' | 'brain'
  writeGate?: { report: WorkerWriteGateReport; repairCount: number }
  timestamp?: number
}

export function buildWorkerEpisode(input: BuildWorkerEpisodeInput): WorkerEpisode {
  const { order, result, writeGate } = input
  return {
    schemaVersion: 1,
    orderId: order.id,
    sessionId: input.sessionId,
    objectiveHash: hashObjective(order.objective),
    model: input.model,
    ...(order.profile ? { profile: order.profile } : {}),
    role: input.role,
    scopeFileCount: order.scope.files?.length ?? 0,
    changedFileCount: result.changedFiles.length,
    status: result.status,
    ...(result.evidenceStatus ? { evidenceStatus: result.evidenceStatus } : {}),
    gateOutcome: writeGate?.report.outcome ?? 'not-run',
    falseGreen: writeGate?.report.falseGreen === true,
    repairCount: writeGate?.repairCount ?? 0,
    timestamp: input.timestamp ?? Date.now(),
  }
}

export interface WorkerEpisodeStore {
  saveBanditState(kind: string, json: string): void
}

export function persistWorkerEpisode(store: WorkerEpisodeStore | undefined | null, episode: WorkerEpisode): void {
  if (!store) return
  try {
    store.saveBanditState(workerEpisodeKey(episode), JSON.stringify(episode))
  } catch {
    // Episode telemetry must never affect delegation.
  }
}

/**
 * Reward derivation (shadow-first):
 * - gate passed              → verificationPass true
 * - gate failed              → verificationPass false (+falseGreen when claimed)
 * - gate blocked             → null: environment-neutral, NO reward row — the
 *                              plan forbids penalizing model capability for
 *                              env failures (tsc timeout, missing deps).
 * - gate skipped / not-run   → read-only or gate disabled: verification was
 *                              not observed; neutral undefined, reward still
 *                              recorded so completion/cost dimensions can be
 *                              extended later without a schema break.
 */
export function deriveWorkerEpisodeRewardInput(episode: WorkerEpisode): RoutingRewardInput | null {
  if (episode.gateOutcome === 'blocked') return null
  const base: RoutingRewardInput = { currentModel: episode.model }
  if (episode.gateOutcome === 'passed') return { ...base, verificationPass: true }
  if (episode.gateOutcome === 'failed') {
    return { ...base, verificationPass: false, ...(episode.falseGreen ? { falseGreen: true } : {}) }
  }
  return base
}
