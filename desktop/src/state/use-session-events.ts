import { useCallback, useSyncExternalStore } from 'react'
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
