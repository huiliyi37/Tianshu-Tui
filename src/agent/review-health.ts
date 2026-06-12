/**
 * Review infrastructure health tracking (B-fix, session 803d897d).
 *
 * The auto review defense line failed silently: a reviewer infra failure was
 * rendered as "verified by available evidence" and nothing recorded that the
 * review never ran. This module keeps a small in-process counter so:
 *   - /status can surface review infra health next to bandit state
 *   - consecutive failures become observable instead of invisible
 *
 * Module-level singleton by design: writers (deliver-task review path) and
 * readers (/status slash handler) live in the same process in both UIs.
 */

export interface ReviewHealthState {
  /** Total auto-review runs attempted (including infra failures). */
  totalRuns: number
  /** Runs where the review produced no usable verdict (infra failure). */
  infraFailureCount: number
  /** Current streak of consecutive infra failures. Reset on any successful run. */
  consecutiveInfraFailures: number
  /** Runs recovered by the in-budget quick retry. */
  retryRecoveredCount: number
  /** Epoch ms of the most recent infra failure. */
  lastFailureAt?: number
  /** Infra failure kinds from the most recent failed run (worker/json/timeout/skip). */
  lastFailureKinds?: string[]
}

let state: ReviewHealthState = {
  totalRuns: 0,
  infraFailureCount: 0,
  consecutiveInfraFailures: 0,
  retryRecoveredCount: 0,
}

export function recordAutoReviewRun(run: {
  /** true when the review produced a usable verdict (verified/rejected). */
  ran: boolean
  /** true when the first attempt failed but the quick retry produced a verdict. */
  recoveredByRetry?: boolean
  /** Infra failure kinds when ran === false. */
  failureKinds?: string[]
}): void {
  state = {
    ...state,
    totalRuns: state.totalRuns + 1,
    infraFailureCount: run.ran ? state.infraFailureCount : state.infraFailureCount + 1,
    consecutiveInfraFailures: run.ran ? 0 : state.consecutiveInfraFailures + 1,
    retryRecoveredCount: run.recoveredByRetry ? state.retryRecoveredCount + 1 : state.retryRecoveredCount,
    ...(run.ran ? {} : { lastFailureAt: Date.now(), lastFailureKinds: run.failureKinds ?? [] }),
  }
}

export function getReviewHealth(): ReviewHealthState {
  return state
}

/** Test-only: reset the singleton between test cases. */
export function resetReviewHealth(): void {
  state = {
    totalRuns: 0,
    infraFailureCount: 0,
    consecutiveInfraFailures: 0,
    retryRecoveredCount: 0,
  }
}

/** One-line summary for /status. */
export function formatReviewHealthLine(): string {
  if (state.totalRuns === 0) return 'reviewHealth: no auto reviews this session'
  const parts = [
    `reviewHealth: ${state.totalRuns - state.infraFailureCount}/${state.totalRuns} runs produced a verdict`,
  ]
  if (state.infraFailureCount > 0) {
    parts.push(`${state.infraFailureCount} infra failure(s)`)
    if (state.consecutiveInfraFailures > 1) parts.push(`${state.consecutiveInfraFailures} consecutive`)
    if (state.lastFailureKinds && state.lastFailureKinds.length > 0) parts.push(`last: ${state.lastFailureKinds.join(',')}`)
  }
  if (state.retryRecoveredCount > 0) parts.push(`${state.retryRecoveredCount} recovered by retry`)
  return parts.join(' — ')
}
