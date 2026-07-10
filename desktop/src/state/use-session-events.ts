import { useCallback, useRef, useSyncExternalStore } from 'react'
import {
  getSessionSnapshot,
  subscribeSession,
  type SessionEventsView,
  type StreamStatus,
} from './session-event-hub'

export type { SessionEventsView, StreamStatus }

/**
 * Subscribe to a session's live event stream and fold it into view state.
 *
 * Thin wrapper over the shared per-session hub (`session-event-hub.ts`): the
 * stream, reducer and rAF batching live there, reference-counted per sessionId,
 * so N hooks pointed at the same session share ONE stream + ONE folded state
 * instead of each opening its own. The behaviour is otherwise unchanged:
 * rebuilds history from since=0 on first subscribe, auto-reconnects with backoff
 * (resuming from the last seq), falls back to polling, and exposes
 * `streamStatus` + `retryStream` for the "live updates stopped" banner.
 */
export function useSessionEvents(sessionId: string | null): SessionEventsView {
  const subscribe = useCallback(
    (onChange: () => void) => (sessionId ? subscribeSession(sessionId, onChange) : () => {}),
    [sessionId],
  )
  const getSnapshot = useCallback(() => getSessionSnapshot(sessionId), [sessionId])
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}

/**
 * Sliced subscription (Wave 3). The hub's notify() wakes EVERY subscriber of a
 * session on every rAF batch — during streaming that cascades re-renders into
 * components that only care about a narrow slice (status, delegation, …).
 * This variant runs `selector` against each new snapshot and keeps the
 * previous selection (same reference) when `isEqual` says nothing changed, so
 * useSyncExternalStore skips the re-render entirely.
 *
 * `selector`/`isEqual` may be inline closures — the latest ones are used at
 * snapshot time, no memoization required by the caller.
 */
export function useSessionEventsSelector<T>(
  sessionId: string | null,
  selector: (view: SessionEventsView) => T,
  isEqual: (a: T, b: T) => boolean = Object.is,
): T {
  const subscribe = useCallback(
    (onChange: () => void) => (sessionId ? subscribeSession(sessionId, onChange) : () => {}),
    [sessionId],
  )
  const latest = useRef({ selector, isEqual })
  latest.current = { selector, isEqual }
  const cache = useRef<{ id: string | null; snap: SessionEventsView; sel: T } | null>(null)

  const getSnapshot = useCallback(() => {
    const snap = getSessionSnapshot(sessionId)
    const c = cache.current
    if (c && c.id === sessionId && c.snap === snap) return c.sel
    const sel = latest.current.selector(snap)
    if (c && c.id === sessionId && latest.current.isEqual(c.sel, sel)) {
      cache.current = { id: sessionId, snap, sel: c.sel }
      return c.sel
    }
    cache.current = { id: sessionId, snap, sel }
    return sel
  }, [sessionId])

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot)
}
