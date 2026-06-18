/**
 * Startup session decision: always fresh, no implicit resume.
 *
 * New contract:
 *   - Default startup mints a FRESH session.
 *   - `--continue`/`--resume`/`RIVET_RESUME=1` explicitly returns to the last
 *     session for the current cwd (regardless of lifecycle/age).
 *   - No implicit resume — not even crash recovery.
 *
 * The decision is pure and injected (no fs/DB here) so it is unit-testable.
 * Resuming returns the previous session id so the existing startup path
 * (`persist.loadOai()` + `session.replaceMessages()`) rehydrates the context
 * automatically — the prefix-cache anchor is untouched because we replay the
 * very same persisted history.
 */

export interface LastSessionInfo {
  /** True when the session jsonl has at least one replayable message. */
  hasContent: boolean
  /** Lifecycle status from session metadata, if any. */
  status?: 'active' | 'completed' | 'archived'
  /** Last mutation time (ms epoch), if known. */
  updatedAt?: number
  /** Working dir the session belongs to. Cross-cwd sessions are never resumed. */
  cwd?: string
  /** True when the previous run exited cleanly. Clean sessions are not auto-resumed. */
  cleanExit?: boolean
}

export interface StartupDecisionInput {
  /** The id recorded in the per-cwd last-session pointer, or null if none. */
  lastSessionId: string | null
  now: number
  /** Don't silently resurrect sessions idle longer than this. */
  freshnessMs: number
  /** User forced a brand-new session (RIVET_NEW_SESSION=1). */
  forceNew: boolean
  /** User explicitly asked to return to the last session (--continue/--resume / RIVET_RESUME=1). */
  resume: boolean
  /**
   * User asked to resume a SPECIFIC session by full id (already resolved from a
   * short prefix by the caller). Takes precedence over `resume`/lastSessionId.
   * RIVET_RESUME_ID=<full-id>.
   */
  resumeSessionId?: string
  /** Disable silent crash-recovery resume (RIVET_NO_AUTO_RESUME=1). Explicit resume still honored. */
  disableAutoResume: boolean
  /** Current working directory — used to reject cross-cwd resume. */
  currentCwd?: string
  /** Loads resumability info for a given session id (null if unreadable). */
  load: (id: string) => LastSessionInfo | null
}

export interface StartupDecision {
  /** The session id to resume, or null to mint a fresh one. */
  sessionId: string | null
  resumed: boolean
  /** Why we resumed / started fresh — for the startup notice + tests. */
  reason: string
}

/** Default: don't silently auto-resume a session idle for more than 24h. */
export const RESUME_FRESHNESS_MS = 24 * 60 * 60 * 1000

export function decideStartupSession(input: StartupDecisionInput): StartupDecision {
  const fresh = { sessionId: null as string | null, resumed: false }

  if (input.forceNew) return { ...fresh, reason: 'forced-new (RIVET_NEW_SESSION=1)' }

  // Explicit specific-session resume (--resume <id>): highest priority. The id
  // is already resolved to a full id by the caller; validate it exists and is
  // not cross-cwd before honoring.
  if (input.resumeSessionId) {
    const info = input.load(input.resumeSessionId)
    if (!info) return { ...fresh, reason: 'requested session unreadable' }
    if (!info.hasContent) return { ...fresh, reason: 'requested session has no replayable content' }
    if (input.currentCwd && info.cwd && info.cwd !== input.currentCwd) {
      return { ...fresh, reason: 'requested session belongs to another cwd' }
    }
    return { sessionId: input.resumeSessionId, resumed: true, reason: 'explicit resume (--resume <id>)' }
  }

  if (!input.lastSessionId) return { ...fresh, reason: 'no previous session' }

  const info = input.load(input.lastSessionId)
  if (!info) return { ...fresh, reason: 'previous session unreadable' }
  if (!info.hasContent) return { ...fresh, reason: 'previous session has no replayable content' }

  // Hard boundary: a session from another project must never bleed into this cwd.
  if (input.currentCwd && info.cwd && info.cwd !== input.currentCwd) {
    return { ...fresh, reason: 'previous session belongs to another cwd' }
  }

  // Explicit resume (--continue/--resume): honor regardless of lifecycle/clean-exit/age.
  if (input.resume) {
    return { sessionId: input.lastSessionId, resumed: true, reason: 'explicit resume (--continue)' }
  }

  // Default is a fresh session — no implicit resume of any kind.
  if (input.disableAutoResume) return { ...fresh, reason: 'auto-resume disabled (RIVET_NO_AUTO_RESUME=1)' }
  if (info.status === 'completed' || info.status === 'archived') {
    return { ...fresh, reason: `previous session ${info.status}` }
  }
  if (info.cleanExit) return { ...fresh, reason: 'previous session exited cleanly' }
  if (typeof info.updatedAt === 'number' && input.now - info.updatedAt > input.freshnessMs) {
    return { ...fresh, reason: 'previous session too old to auto-resume' }
  }
  return { ...fresh, reason: 'default new session' }
}
