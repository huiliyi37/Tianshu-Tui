/**
 * Constellation post-session hook — 主控 seals the session's departure mark.
 *
 * Two paths, both producing the single idempotent departure milestone for the
 * session:
 *  1. The agent left a mark (leave_mark tool) → record it with the agent's
 *     self-chosen symbol + summary. Identity is earned, not assigned.
 *  2. Safety net — the agent did real work but left no mark → record an
 *     unsigned journey (symbol '·') so the starmap keeps growing.
 *
 * Pure post-session side effect, opt-in, never mutates prompt state or runs
 * during turns (cache-safe by construction).
 */
import type { PostSessionRuntimeHook } from '../runtime-hooks.js'
import type { TaskLedgerSummary } from '../task-ledger.js'
import type { ChronicleEntry } from '../chronicle.js'
import type { LeaveMarkInput } from '../../tools/types.js'
import { createCycleClose } from '../songline.js'
import { appendMilestone, surveySkeleton, initConstellation, loadConstellation } from '../../constellation/store.js'
import {
  buildDepartureMilestone,
  collectFilesChanged,
  deriveSummary,
} from '../../constellation/milestone.js'
import { buildAgentMark, VOID_SYMBOL } from '../void-identity.js'
import type { MilestoneType } from '../../constellation/schema.js'

export interface ConstellationHookDeps {
  /** Explicit opt-in. */
  enabled: boolean
  cwd: string
  sessionId: string
  /** Agent's self-chosen departure mark, if it left one (leave_mark tool). */
  getPendingMark?: () => LeaveMarkInput | null
  getTaskSummary?: () => TaskLedgerSummary | null
  getChronicleEntries?: () => readonly ChronicleEntry[]
  getDomainId?: () => string | null | undefined
  /** Session's ephemeral numeric id — ensures departure mark matches arrival. */
  getNumericId?: () => number | null
  /** Minimum changed files for the anonymous safety net to fire. Default 1. */
  minFiles?: number
  now?: () => number
}

export function createConstellationRuntimeHook(deps: ConstellationHookDeps): PostSessionRuntimeHook {
  return {
    phase: 'postSession',
    name: 'constellation-runtime',
    async run() {
      if (!deps.enabled) return
      try {
        const now = deps.now?.() ?? Date.now()
        const domain = deps.getDomainId?.() ?? ''
        const entries = deps.getChronicleEntries?.() ?? []
        const summary = deps.getTaskSummary?.() ?? null
        const cycleClose = summary ? createCycleClose(summary) : ''
        const pending = deps.getPendingMark?.() ?? null

        if (pending) {
          // The agent left its own mark — seal it as the identity anchor.
          const milestone = buildDepartureMilestone({
            sessionId: deps.sessionId,
            agentMark: buildAgentMark({ symbol: pending.symbol, domain, numericId: deps.getNumericId?.() ?? undefined }),
            domain,
            summary: pending.summary,
            filesChanged: collectFilesChanged(entries),
            type: pending.type as MilestoneType | undefined,
            tags: pending.tags,
            verificationStatus: summary?.verificationStatus,
            cycleClose,
            now,
          })
          appendMilestone(deps.cwd, milestone, now)
          // P3: re-survey skeleton after file changes (pending mark path)
          surveyAndUpdateSkeleton(deps.cwd, deps.sessionId, domain, collectFilesChanged(entries), now)
          return
        }

        // Safety net: no mark left. Record an unsigned journey only if the
        // session actually touched files (noise gate).
        const filesChanged = collectFilesChanged(entries)
        const wrote = summary?.writeFileCount ?? filesChanged.length
        const minFiles = deps.minFiles ?? 1
        if (wrote < minFiles) return

        const milestone = buildDepartureMilestone({
          sessionId: deps.sessionId,
          agentMark: buildAgentMark({ symbol: VOID_SYMBOL, domain, numericId: deps.getNumericId?.() ?? undefined }),
          domain,
          summary: deriveSummary(entries, 'milestone', filesChanged.length),
          filesChanged,
          type: 'milestone',
          verificationStatus: summary?.verificationStatus,
          cycleClose,
          now,
        })
        appendMilestone(deps.cwd, milestone, now)
        // P3: re-survey skeleton after file changes (safety net path)
        surveyAndUpdateSkeleton(deps.cwd, deps.sessionId, domain, filesChanged, now)
      } catch {
        // Post-session side effect must never affect the session outcome.
      }
    },
  }
}

/** P3: Re-survey the project skeleton and record architecture shifts if modules changed. */
function surveyAndUpdateSkeleton(cwd: string, sessionId: string, domain: string, filesChanged: readonly string[], now: number): void {
  if (filesChanged.length === 0) return
  if (!loadConstellation(cwd)) return
  try {
    const fresh = surveySkeleton(cwd)
    initConstellation(cwd, {
      skeleton: fresh,
      sessionId,
      shiftSummary: `auto-detected after ${filesChanged.length} file(s) changed by ${domain}`,
    }, now)
  } catch {
    // skeleton re-survey is best-effort
  }
}
