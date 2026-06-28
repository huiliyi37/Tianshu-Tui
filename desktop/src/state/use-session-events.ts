import { useCallback, useEffect, useReducer, useRef, useState } from 'react'
import { streamSession } from '../runtime/sse'
import { fetchEvents } from '../runtime/client'
import { eventReducer, initialEventState, type EventViewState } from './event-reducer'
import type { SessionEvent } from '../runtime/types'

/**
 * Live-stream connection state, surfaced to the UI so a dropped/dead stream is
 * never silent:
 *   - 'connecting'   — initial connect (or a retry) is in flight; no banner.
 *   - 'live'         — connected; events flow.
 *   - 'reconnecting' — a transient drop; auto-retrying with backoff (subtle hint).
 *   - 'offline'      — retry budget exhausted; the loop stopped. The UI shows a
 *                      banner with a manual retry so the user is never stranded
 *                      on a frozen thread while /health may still read green.
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

export type SessionEventsView = EventViewState & {
  streamStatus: StreamStatus
  /** Manually restart a stopped ('offline') stream; resumes from the last seq. */
  retryStream: () => void
}

/**
 * Subscribe to a session's live event stream and fold it into view state.
 *
 * - Rebuilds full history from since=0 on open, then streams live.
 * - Auto-reconnects after a transient drop, resuming from the last folded seq
 *   (?since= backfill) so nothing is lost and a viewer drop never aborts the run.
 * - Falls back to one-shot polling if the streaming endpoint is unavailable.
 * - Exposes `streamStatus` + `retryStream` so the UI can show a "live updates
 *   stopped" banner and let the user reconnect once the retry budget runs out
 *   (the prior behaviour silently froze the thread with no signal).
 *
 * Performance: SSE events are buffered and flushed once per animation frame
 * (rAF, ~16ms). Without batching, each text_delta token triggers a separate
 * dispatch + React render — hundreds per second during streaming. With rAF
 * batching, we coalesce all events arriving within one frame into a single
 * dispatch via the reducer's 'events' action.
 */
export function useSessionEvents(sessionId: string | null): SessionEventsView {
  const [state, dispatch] = useReducer(eventReducer, initialEventState)
  const [streamStatus, setStreamStatus] = useState<StreamStatus>('connecting')
  // Bumping this re-runs the stream-loop effect WITHOUT resetting folded history
  // (the reset effect is keyed on sessionId only), so a manual retry resumes
  // from the last seq instead of replaying from scratch.
  const [retryNonce, setRetryNonce] = useState(0)
  const seqRef = useRef(0)

  const retryStream = useCallback(() => setRetryNonce((n) => n + 1), [])

  // Reset folded history only when the session itself changes — NOT on a retry.
  useEffect(() => {
    dispatch({ type: 'reset' })
    seqRef.current = 0
  }, [sessionId])

  useEffect(() => {
    if (!sessionId) {
      setStreamStatus('connecting')
      return
    }
    setStreamStatus('connecting')

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

    const onOpen = () => {
      if (!stopped) setStreamStatus('live')
    }

    const loop = async () => {
      // U5: exponential backoff with a cap and a finite retry budget so a
      // sidecar outage does not turn into an unbounded reconnect storm.
      let failures = 0
      const MAX_RETRIES = 8
      const BASE_DELAY = 1500
      const MAX_DELAY = 30000

      while (!stopped) {
        try {
          await streamSession(sessionId, seqRef.current, onEvent, ac.signal, onOpen)
          // Stream ended cleanly (server closed). Pause briefly then reconnect
          // to keep watching for a possible new run on the same session.
          failures = 0
          if (stopped) return
          await delay(BASE_DELAY)
        } catch {
          if (stopped) return
          failures++
          if (failures > MAX_RETRIES) {
            // Sidecar/stream has been down too long; stop reconnecting and tell
            // the UI so it can offer a manual retry instead of freezing silently.
            if (!stopped) setStreamStatus('offline')
            return
          }
          if (!stopped) setStreamStatus('reconnecting')
          const backoff = Math.min(BASE_DELAY * 2 ** (failures - 1), MAX_DELAY)
          // Network/stream error — try a polling backfill, then reconnect.
          try {
            const { events } = await fetchEvents(sessionId, seqRef.current)
            for (const e of events) onEvent(e)
          } catch {
            // sidecar likely down; surfaced elsewhere via health
          }
          await delay(backoff)
        }
      }
    }
    void loop()

    return () => {
      stopped = true
      ac.abort()
      if (rafId !== null) cancelAnimationFrame(rafId)
    }
  }, [sessionId, retryNonce])

  return { ...state, streamStatus, retryStream }
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}
