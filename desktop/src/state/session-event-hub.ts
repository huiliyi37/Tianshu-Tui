import { streamSession as realStreamSession } from '../runtime/sse'
import { fetchEvents as realFetchEvents } from '../runtime/client'
import { eventReducer, initialEventState, type EventViewState } from './event-reducer'
import type { SessionEvent } from '../runtime/types'

// Transport indirection: tests swap these for fakes to exercise the hub's
// reference-counting / fan-out / reconnect orchestration without real network.
type StreamFn = typeof realStreamSession
type FetchEventsFn = typeof realFetchEvents
let streamSession: StreamFn = realStreamSession
let fetchEvents: FetchEventsFn = realFetchEvents

export function __setHubTransport(opts: { streamSession?: StreamFn; fetchEvents?: FetchEventsFn }): void {
  if (opts.streamSession) streamSession = opts.streamSession
  if (opts.fetchEvents) fetchEvents = opts.fetchEvents
}

export function __resetHubTransport(): void {
  streamSession = realStreamSession
  fetchEvents = realFetchEvents
}

/** Test-only: number of live (still-subscribed) per-session stores. */
export function __activeStoreCount(): number {
  return stores.size
}

/**
 * Live-stream connection state, surfaced to the UI so a dropped/dead stream is
 * never silent:
 *   - 'connecting'   — initial connect (or a retry) is in flight; no banner.
 *   - 'live'         — connected; events flow.
 *   - 'reconnecting' — a transient drop; auto-retrying with backoff (subtle hint).
 *   - 'offline'      — retry budget exhausted; the loop stopped. The UI shows a
 *                      banner with a manual retry so the user is never stranded.
 */
export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'offline'

export type SessionEventsView = EventViewState & {
  streamStatus: StreamStatus
  /** Manually restart a stopped ('offline') stream; resumes from the last seq. */
  retryStream: () => void
}

/**
 * Per-session shared subscription hub.
 *
 * Previously every `useSessionEvents` call opened its OWN SSE stream + ran its
 * OWN reducer. With Mission Control (live cards) plus the workspace thread, the
 * Delegation panel and the Hooks panel, several hooks routinely target the SAME
 * session at once — multiplying streams, reducer churn and from-scratch history
 * replays. This hub keeps exactly ONE stream + ONE folded state per sessionId,
 * reference-counted, and fans changes out to all subscribers via
 * useSyncExternalStore. When the last subscriber leaves, the stream is torn down
 * and the store evicted (a re-subscribe replays from seq 0, matching the prior
 * per-mount behaviour — no memory growth across many viewed sessions).
 */
interface Store {
  state: EventViewState
  status: StreamStatus
  /** Cached immutable snapshot handed to useSyncExternalStore — only replaced
   *  when state/status actually change, so getSnapshot stays referentially stable. */
  snapshot: SessionEventsView
  listeners: Set<() => void>
  refCount: number
  /** Highest folded seq; reconnects resume from here (?since=) so nothing is lost. */
  seq: number
  ac: AbortController | null
  stopped: boolean
  /** Bumped on stop/retry to fence any in-flight loop + rAF callbacks. */
  generation: number
  pending: SessionEvent[]
  rafId: number | null
  retry: () => void
}

const stores = new Map<string, Store>()

const EMPTY_SNAPSHOT: SessionEventsView = {
  ...initialEventState,
  streamStatus: 'connecting',
  retryStream: () => {},
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

function refreshSnapshot(store: Store): void {
  store.snapshot = { ...store.state, streamStatus: store.status, retryStream: store.retry }
}

function notify(store: Store): void {
  refreshSnapshot(store)
  for (const l of store.listeners) l()
}

function startLoop(id: string, store: Store): void {
  const ac = new AbortController()
  store.ac = ac
  store.stopped = false
  store.status = 'connecting'
  const gen = store.generation

  const flush = () => {
    store.rafId = null
    if (store.generation !== gen || store.pending.length === 0) return
    const batch = store.pending
    store.pending = []
    store.state = eventReducer(store.state, { type: 'events', events: batch })
    notify(store)
  }

  const onEvent = (e: SessionEvent) => {
    if (store.generation !== gen) return
    if (e.seq > store.seq) store.seq = e.seq
    store.pending.push(e)
    if (store.rafId === null) store.rafId = requestAnimationFrame(flush)
  }

  const onOpen = () => {
    if (store.stopped || store.generation !== gen || store.status === 'live') return
    store.status = 'live'
    notify(store)
  }

  void (async () => {
    // U5: exponential backoff with a cap and a finite retry budget so a sidecar
    // outage doesn't turn into an unbounded reconnect storm.
    let failures = 0
    const MAX_RETRIES = 8
    const BASE_DELAY = 1500
    const MAX_DELAY = 30000

    while (!store.stopped && store.generation === gen) {
      try {
        await streamSession(id, store.seq, onEvent, ac.signal, onOpen)
        failures = 0
        if (store.stopped || store.generation !== gen) return
        await delay(BASE_DELAY)
      } catch {
        if (store.stopped || store.generation !== gen) return
        failures++
        if (failures > MAX_RETRIES) {
          store.status = 'offline'
          notify(store)
          return
        }
        store.status = 'reconnecting'
        notify(store)
        const backoff = Math.min(BASE_DELAY * 2 ** (failures - 1), MAX_DELAY)
        // Network/stream error — try a polling backfill, then reconnect.
        try {
          const { events } = await fetchEvents(id, store.seq)
          for (const e of events) onEvent(e)
        } catch {
          // sidecar likely down; surfaced elsewhere via health
        }
        await delay(backoff)
      }
    }
  })()
}

function stopLoop(store: Store): void {
  store.stopped = true
  store.generation += 1 // fence in-flight loop + queued rAF callbacks
  store.ac?.abort()
  store.ac = null
  if (store.rafId !== null) {
    cancelAnimationFrame(store.rafId)
    store.rafId = null
  }
  store.pending = []
}

function createStore(id: string): Store {
  const store: Store = {
    state: initialEventState,
    status: 'connecting',
    snapshot: EMPTY_SNAPSHOT,
    listeners: new Set(),
    refCount: 0,
    seq: 0,
    ac: null,
    stopped: true,
    generation: 0,
    pending: [],
    rafId: null,
    retry: () => {},
  }
  store.retry = () => {
    // Resume from the last folded seq — restart the loop WITHOUT resetting
    // history, so a manual retry backfills instead of replaying from scratch.
    stopLoop(store)
    startLoop(id, store)
    notify(store)
  }
  refreshSnapshot(store)
  return store
}

/** Subscribe to a session's shared event store. Starts the stream on the first
 *  subscriber and tears it down (and evicts the store) when the last leaves. */
export function subscribeSession(id: string, onChange: () => void): () => void {
  let store = stores.get(id)
  if (!store) {
    store = createStore(id)
    stores.set(id, store)
  }
  store.listeners.add(onChange)
  store.refCount += 1
  if (store.refCount === 1) startLoop(id, store)
  return () => {
    const s = stores.get(id)
    if (!s) return
    s.listeners.delete(onChange)
    s.refCount -= 1
    if (s.refCount <= 0) {
      stopLoop(s)
      stores.delete(id)
    }
  }
}

/** Read the current immutable snapshot for a session (no side effects). */
export function getSessionSnapshot(id: string | null): SessionEventsView {
  if (!id) return EMPTY_SNAPSHOT
  return stores.get(id)?.snapshot ?? EMPTY_SNAPSHOT
}
