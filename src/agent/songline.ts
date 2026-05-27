import { createHash } from 'node:crypto'
import type { PheromoneDeposit } from '../context/stigmergy.js'
import type { DeliveryVerificationLevel, TaskLedgerSummary } from './task-ledger.js'

export interface CycleOpenInput {
  sessionId: string
  prevCycleClose: string | null
}

function sha256(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, value))
}

function strengthForVerification(status: DeliveryVerificationLevel): number {
  switch (status) {
    case 'verified':
      return 1
    case 'external_blocked':
      return 0.7
    case 'blocked':
      return 0.5
    case 'unverified':
      return 0.4
    case 'failed':
      return 0.2
  }
}

/**
 * Create the cycle_open value for a session.
 *
 * If a previous cycle_close exists, inheriting it preserves the relay chain.
 * Otherwise we derive a deterministic first open from the session id; runtime
 * callers can still provide high-entropy session ids without introducing hidden
 * Date.now() nondeterminism into tests or replay.
 */
export function createCycleOpen(input: CycleOpenInput): string {
  return input.prevCycleClose ?? sha256(`cycle-open:${input.sessionId}`)
}

/** Build a deterministic close hash from the task-level substrate summary. */
export function createCycleClose(summary: TaskLedgerSummary): string {
  return sha256(JSON.stringify({
    taskId: summary.taskId,
    eventCount: summary.eventCount,
    readFileCount: summary.readFileCount,
    writeFileCount: summary.writeFileCount,
    ownedFileCount: summary.ownedFileCount,
    verificationCount: summary.verificationCount,
    verificationStatus: summary.verificationStatus,
    firstEventAt: summary.firstEventAt,
    lastEventAt: summary.lastEventAt,
  }))
}

/**
 * Convert TaskLedger's factual summary into a neutral pheromone deposit.
 *
 * This does not perform I/O. Callers choose when/where to deposit so substrate v0
 * stays out of runtime hooks and prefix-sensitive prompt construction.
 */
export function taskSummaryToObligationDeposit(
  summary: TaskLedgerSummary,
  path = `task://${summary.taskId}`,
): PheromoneDeposit {
  const baseStrength = strengthForVerification(summary.verificationStatus)
  const activityBoost = summary.eventCount > 0 ? 0.05 : 0
  const verificationBoost = summary.verificationCount > 0 ? 0.05 : 0
  const strength = summary.verificationStatus === 'failed'
    ? baseStrength
    : clamp(baseStrength + activityBoost + verificationBoost)

  return {
    path,
    signal: 'obligation-fulfilled',
    strength,
    context:
      `task=${summary.taskId}; status=${summary.verificationStatus}; ` +
      `events=${summary.eventCount}; owned=${summary.ownedFileCount}; verifications=${summary.verificationCount}`,
  }
}
