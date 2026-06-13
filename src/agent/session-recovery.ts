/**
 * Cold-start / crash auto-resume decision.
 *
 * Historically `getOrCreateSessionId()` always minted a fresh UUID, so a crash
 * (or any restart) silently dropped the in-flight task — the user had to know
 * about and run `/resume`. For an unattended, autonomy-first agent that is a
 * dead end: a crashed long-running task must pick itself back up.
 *
 * The decision is pure and injected (no fs/DB here) so it is unit-testable.
 * The caller wires in a loader that reports whether the last session has
 * resumable content + its lifecycle status + last-touched time. Returning the
 * previous session id makes the existing startup path (which already calls
 * `persist.loadOai()` + `session.replaceMessages()`) rehydrate the context
 * automatically — no separate restore plumbing, and the prefix-cache anchor is
 * untouched because we replay the very same persisted history.
 */

export interface LastSessionInfo {
  /** True when the session jsonl has at least one replayable message. */
  hasContent: boolean
  /** Lifecycle status from session metadata, if any. */
  status?: 'active' | 'completed' | 'archived'
  /** Last mutation time (ms epoch), if known. */
  updatedAt?: number
}

export interface StartupDecisionInput {
  /** The id recorded in ~/.rivet/session-id.txt, or null if none. */
  lastSessionId: string | null
  now: number
  /** Don't resurrect sessions idle longer than this. */
  freshnessMs: number
  /** User forced a brand-new session (RIVET_NEW_SESSION=1). */
  forceNew: boolean
  /** User disabled auto-resume (RIVET_NO_AUTO_RESUME=1). */
  disableAutoResume: boolean
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

/** Default: don't auto-resume a session idle for more than 24h. */
export const RESUME_FRESHNESS_MS = 24 * 60 * 60 * 1000

export function decideStartupSession(input: StartupDecisionInput): StartupDecision {
  const fresh = { sessionId: null as string | null, resumed: false }

  if (input.forceNew) return { ...fresh, reason: 'forced-new (RIVET_NEW_SESSION=1)' }
  if (input.disableAutoResume) return { ...fresh, reason: 'auto-resume disabled (RIVET_NO_AUTO_RESUME=1)' }
  if (!input.lastSessionId) return { ...fresh, reason: 'no previous session' }

  const info = input.load(input.lastSessionId)
  if (!info) return { ...fresh, reason: 'previous session unreadable' }
  if (!info.hasContent) return { ...fresh, reason: 'previous session has no replayable content' }
  if (info.status === 'completed' || info.status === 'archived') {
    return { ...fresh, reason: `previous session ${info.status}` }
  }
  if (typeof info.updatedAt === 'number' && input.now - info.updatedAt > input.freshnessMs) {
    return { ...fresh, reason: 'previous session too old to auto-resume' }
  }

  return { sessionId: input.lastSessionId, resumed: true, reason: 'auto-resumed interrupted session' }
}
