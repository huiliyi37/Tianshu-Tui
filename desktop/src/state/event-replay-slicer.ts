import { eventReducer, type EventViewState } from './event-reducer'
import type { SessionEvent } from '../runtime/types'

export const EVENT_REPLAY_SLICE_EVENTS = 400
export const EVENT_REPLAY_SLICE_MS = 6
const REDUCER_CHUNK_EVENTS = 10

export interface EventReplaySlice {
  state: EventViewState
  consumed: number
  durationMs: number
}

/** Fold one bounded UI-frame slice without mutating the caller's event array. */
export function foldEventSlice(
  initialState: EventViewState,
  events: readonly SessionEvent[],
  now: () => number = () => performance.now(),
): EventReplaySlice {
  const startedAt = now()
  let state = initialState
  let consumed = 0
  while (
    consumed < events.length &&
    consumed < EVENT_REPLAY_SLICE_EVENTS &&
    (consumed === 0 || now() - startedAt < EVENT_REPLAY_SLICE_MS)
  ) {
    const chunkSize = Math.min(
      REDUCER_CHUNK_EVENTS,
      EVENT_REPLAY_SLICE_EVENTS - consumed,
      events.length - consumed,
    )
    state = eventReducer(state, {
      type: 'events',
      events: events.slice(consumed, consumed + chunkSize),
    })
    consumed += chunkSize
  }
  return { state, consumed, durationMs: now() - startedAt }
}
