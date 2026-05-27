import type { PheromoneDeposit } from '../../context/stigmergy.js'
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { TaskLedgerSummary } from '../task-ledger.js'
import { createCycleClose, taskSummaryToObligationDeposit } from '../songline.js'

export interface SonglineRuntimeHookDeps {
  /** Explicit opt-in: substrate v0.1 must stay silent unless enabled. */
  enabled: boolean
  getTaskSummary: () => TaskLedgerSummary | null
  deposit: (deposit: PheromoneDeposit) => Promise<void> | void
  /** Optional session id for cycle relay persistence. */
  sessionId?: string
  /** Optional registry bridge; omitted means no cycle relay side effect. */
  setCycleClose?: (sessionId: string, closeHash: string) => void
}

function hasActivity(summary: TaskLedgerSummary): boolean {
  return summary.eventCount > 0 || summary.verificationCount > 0 || summary.ownedFileCount > 0
}

/**
 * Optional Songline post-session bridge.
 *
 * The hook converts TaskLedger's factual summary into a neutral pheromone and,
 * when a registry bridge is provided, persists the deterministic cycle close.
 * It does not mutate prompt state or run during turns.
 */
export function createSonglineRuntimeHook(deps: SonglineRuntimeHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'songline-runtime',
    async run() {
      if (!deps.enabled) return

      const summary = deps.getTaskSummary()
      if (!summary || !hasActivity(summary)) return

      await deps.deposit(taskSummaryToObligationDeposit(summary))

      if (deps.sessionId && deps.setCycleClose) {
        deps.setCycleClose(deps.sessionId, createCycleClose(summary))
      }
    },
  }
}
