import { useEffect, useReducer, useRef } from 'react'
import { streamSession } from '../runtime/sse'
import { fetchEvents } from '../runtime/client'
import { eventReducer, initialEventState, type EventViewState } from './event-reducer'
import type { SessionEvent } from '../runtime/types'

/**
 * Subscribe to a session's live event stream and fold it into view state.
 *
 * - Rebuilds full history from since=0 on open, then streams live.
 * - Auto-reconnects after a transient drop, resuming from the last folded seq
 *   (?since= backfill) so nothing is lost and a viewer drop never aborts the run.
 * - Falls back to one-shot polling if the streaming endpoint is unavailable.
 *
 * Performance: SSE events are buffered and flushed once per animation frame
 * (rAF, ~16ms). Without batching, each text_delta token triggers a separate
 * dispatch + React render — hundreds per second during streaming. With rAF
 * batching, we coalesce all events arriving within one frame into a single
 * dispatch via the reducer's 'events' action.
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

    // rAF batching buffer: accumulate events between frames, flush once.
    let pending: SessionEvent[] = []
    let rafId: number | null = null

    const flush = () => {
      rafId = null
      if (pending.length === 0) return
      const batch = pending
      pending = []
      dispatch({ type: 'events', events: batch })
    }

    const onEvent = (e: { seq: number }) => {
      if (e.seq > seqRef.current) seqRef.current = e.seq
      pending.push(e as SessionEvent)
      if (rafId === null) {
        rafId = requestAnimationFrame(flush)
      }
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
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [sessionId])

  return state
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
