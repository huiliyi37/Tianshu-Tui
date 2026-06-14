/**
 * Constellation post-session hook — auto-records one milestone per session.
 *
 * Mirrors the Songline hook's shape: pure post-session side effect, opt-in,
 * never mutates prompt state or runs during turns (cache-safe by construction).
 * Reuses the deterministic cycle_close hash, the TaskLedger summary (honest
 * verification), and — when available — the behavior fingerprint to stamp a
 * stable agent mark.
 */
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { TaskLedgerSummary } from '../task-ledger.js'
import type { ChronicleEntry } from '../chronicle.js'
import type { RetrospectFingerprint } from '../retrospect-fingerprint.js'
import { createCycleClose } from '../songline.js'
import { appendMilestone } from '../../constellation/store.js'
import { extractMilestone } from '../../constellation/milestone.js'
import { generateVoidIdentity, toAgentMark } from '../void-identity.js'
import type { MilestoneType } from '../../constellation/schema.js'

export interface ConstellationHookDeps {
  /** Explicit opt-in. */
  enabled: boolean
  cwd: string
  sessionId: string
  getTaskSummary: () => TaskLedgerSummary | null
  getChronicleEntries?: () => readonly ChronicleEntry[]
  getDomainId?: () => string | null | undefined
  getFingerprint?: () => RetrospectFingerprint | null
  minFiles?: number
  type?: MilestoneType
  now?: () => number
}

export function createConstellationRuntimeHook(deps: ConstellationHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'constellation-runtime',
    async run() {
      if (!deps.enabled) return
      try {
        const summary = deps.getTaskSummary()
        if (!summary) return

        const now = deps.now?.() ?? Date.now()
        const domain = deps.getDomainId?.() ?? ''
        const entries = deps.getChronicleEntries?.() ?? []
        const cycleClose = createCycleClose(summary)
        const identity = generateVoidIdentity({
          sessionId: deps.sessionId,
          fingerprint: deps.getFingerprint?.() ?? null,
          domain: domain || undefined,
        })

        const milestone = extractMilestone({
          sessionId: deps.sessionId,
          agentMark: toAgentMark(identity, domain),
          domain,
          chronicleEntries: entries,
          taskSummary: summary,
          cycleClose,
          type: deps.type,
          minFiles: deps.minFiles,
          now,
        })
        if (!milestone) return

        appendMilestone(deps.cwd, milestone, now)
      } catch {
        // Post-session side effect must never affect the session outcome.
      }
    },
  }
}
