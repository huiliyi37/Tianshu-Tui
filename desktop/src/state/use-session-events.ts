import { useEffect, useReducer, useRef } from 'react'
import { streamSession } from '../runtime/sse'
import { fetchEvents } from '../runtime/client'
import { eventReducer, initialEventState, type EventViewState } from './event-reducer'

/**
 * Subscribe to a session's live event stream and fold it into view state.
 *
 * - Rebuilds full history from since=0 on open, then streams live.
 * - Auto-reconnects after a transient drop, resuming from the last folded seq
 *   (?since= backfill) so nothing is lost and a viewer drop never aborts the run.
 * - Falls back to one-shot polling if the streaming endpoint is unavailable.
 */
export function useSessionEvents(sessionId: string | null): EventViewState {
  const [state, dispatch] = useReducer(eventReducer, initialEventState)
  const seqRef = useRef(0)

  useEffect(() => {
    dispatch({ type: 'reset' })
    seqRef.current = 0
    if (!sessionId) return

    const ac = new AbortController()
    let stopped = false

    const onEvent = (e: { seq: number }) => {
      if (e.seq > seqRef.current) seqRef.current = e.seq
      dispatch({ type: 'event', event: e as never })
    }

    const loop = async () => {
      while (!stopped) {
        try {
          await streamSession(sessionId, seqRef.current, onEvent, ac.signal)
          // Stream ended cleanly (server closed). Pause briefly then reconnect
          // to keep watching for a possible new run on the same session.
          if (stopped) return
          await delay(1500)
        } catch {
          if (stopped) return
          // Network/stream error — try a polling backfill, then reconnect.
          try {
            const { events } = await fetchEvents(sessionId, seqRef.current)
            for (const e of events) onEvent(e)
          } catch {
            // sidecar likely down; surfaced elsewhere via health
          }
          await delay(1500)
        }
      }
    }
    void loop()

    return () => {
      stopped = true
      ac.abort()
    }
  }, [sessionId])

  return state
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
