import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  subscribeSession,
  getSessionSnapshot,
  __setHubTransport,
  __resetHubTransport,
  __activeStoreCount,
  __setHubFallbackFlushMs,
} from '../session-event-hub'
import { eventReducer, initialEventState } from '../event-reducer'
import type { SessionEvent } from '../../runtime/types'

// The hub batches reducer flushes through requestAnimationFrame; node has no DOM,
// so polyfill it with a macrotask. cancelAnimationFrame maps to clearTimeout.
const g = globalThis as unknown as {
  requestAnimationFrame?: (cb: () => void) => number
  cancelAnimationFrame?: (id: number) => void
}
g.requestAnimationFrame = (cb: () => void) => setTimeout(cb, 0) as unknown as number
g.cancelAnimationFrame = (id: number) => clearTimeout(id as unknown as NodeJS.Timeout)

function tick(ms = 5): Promise<void> {
  return new Promise((r) => setTimeout(r, ms))
}

/** A fake stream that records start count + the abort signal, replays the given
 *  events on connect, then stays open until aborted (mirrors a live SSE loop). */
function makeFakeTransport(events: SessionEvent[]) {
  const state = { calls: 0, signals: [] as AbortSignal[] }
  const streamSession = (
    _id: string,
    _since: number,
    onEvent: (e: SessionEvent) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> => {
    state.calls += 1
    state.signals.push(signal)
    onOpen?.()
    for (const e of events) onEvent(e)
    return new Promise<void>((_resolve, reject) => {
      const fail = () => reject(new DOMException('aborted', 'AbortError'))
      if (signal.aborted) fail()
      else signal.addEventListener('abort', fail, { once: true })
    })
  }
  const fetchEvents = async () => ({ events: [], lastSeq: 0 })
  return { state, streamSession, fetchEvents }
}

test('getSessionSnapshot returns the shared empty view for a null id', () => {
  const a = getSessionSnapshot(null)
  const b = getSessionSnapshot(null)
  assert.equal(a, b)
  assert.equal(a.streamStatus, 'connecting')
  assert.equal(a.blocks.length, 0)
})

test('two subscribers to one session share a single stream', async () => {
  const fake = makeFakeTransport([])
  __setHubTransport(fake)
  try {
    const unsubA = subscribeSession('s-share', () => {})
    const unsubB = subscribeSession('s-share', () => {})
    await tick()
    assert.equal(fake.state.calls, 1, 'only one stream started for the shared session')
    assert.equal(__activeStoreCount(), 1)
    unsubA()
    unsubB()
  } finally {
    __resetHubTransport()
  }
})

test('events fan out to every subscriber and fold into the shared snapshot', async () => {
  const events: SessionEvent[] = [
    { seq: 1, ts: 0, type: 'user', data: { text: 'hello' } } as SessionEvent,
    { seq: 2, ts: 0, type: 'text_delta', data: { text: 'hi ' } } as SessionEvent,
    { seq: 3, ts: 0, type: 'text_delta', data: { text: 'there' } } as SessionEvent,
  ]
  const fake = makeFakeTransport(events)
  __setHubTransport(fake)
  try {
    let aCount = 0
    let bCount = 0
    const unsubA = subscribeSession('s-fan', () => { aCount += 1 })
    const unsubB = subscribeSession('s-fan', () => { bCount += 1 })
    await tick()
    const view = getSessionSnapshot('s-fan')
    assert.equal(view.streamStatus, 'live')
    assert.equal(view.lastSeq, 3)
    // user block + one coalesced assistant block.
    assert.equal(view.blocks.length, 2)
    assert.equal(view.blocks[0]!.kind, 'user')
    assert.equal(view.blocks[1]!.text, 'hi there')
    assert.ok(aCount > 0 && bCount > 0, 'both listeners were notified')
    unsubA()
    unsubB()
  } finally {
    __resetHubTransport()
  }
})

test('background fallback: events still fold when rAF never fires (hidden window)', async () => {
  // Simulate a hidden/occluded window: rAF hands out ids but never runs the
  // callback — exactly what WebViews do when the window is not visible.
  const prevRaf = g.requestAnimationFrame
  g.requestAnimationFrame = () => 999
  __setHubFallbackFlushMs(20)
  const events: SessionEvent[] = [
    { seq: 1, ts: 0, type: 'user', data: { text: 'bg' } } as SessionEvent,
    { seq: 2, ts: 0, type: 'status', data: { status: 'completed' } } as SessionEvent,
  ]
  const fake = makeFakeTransport(events)
  __setHubTransport(fake)
  try {
    const unsub = subscribeSession('s-bg', () => {})
    await tick(60) // > fallback deadline, no rAF ever fires
    const view = getSessionSnapshot('s-bg')
    assert.equal(view.lastSeq, 2, 'fallback timer must fold pending events without rAF')
    assert.equal(view.status, 'completed', 'status (→notifications) must not freeze in background')
    unsub()
  } finally {
    g.requestAnimationFrame = prevRaf
    __setHubFallbackFlushMs(250)
    __resetHubTransport()
  }
})

test('large replay drains at most 400 events per frame and matches a one-shot fold', async () => {
  const prevRaf = g.requestAnimationFrame
  const frames: Array<() => void> = []
  g.requestAnimationFrame = (cb) => {
    frames.push(cb)
    return frames.length
  }
  __setHubFallbackFlushMs(60_000) // fallback effectively disabled
  const events: SessionEvent[] = []
  for (let i = 1; i <= 1000; i++) {
    events.push({ seq: i, ts: 0, type: 'text_delta', data: { text: 'x' } } as SessionEvent)
  }
  const fake = makeFakeTransport(events)
  __setHubTransport(fake)
  let unsub: (() => void) | undefined
  let notifications = 0
  try {
    unsub = subscribeSession('s-cap', () => { notifications++ })
    assert.equal(frames.length, 1, 'the burst should schedule one initial frame')

    frames.shift()!()
    assert.equal(getSessionSnapshot('s-cap').lastSeq, 400, 'one frame must fold at most 400 events')
    assert.equal(frames.length, 1, 'remaining events should schedule another frame')

    while (frames.length > 0) frames.shift()!()
    const view = getSessionSnapshot('s-cap')
    const oneShot = eventReducer(initialEventState, { type: 'events', events })
    assert.equal(view.lastSeq, oneShot.lastSeq)
    assert.deepEqual(view.blocks, oneShot.blocks, 'sliced folding must equal one-shot folding')
    assert.ok(notifications <= 21, `1000 events should notify at most 21 times, got ${notifications}`)
  } finally {
    unsub?.()
    g.requestAnimationFrame = prevRaf
    __setHubFallbackFlushMs(250)
    __resetHubTransport()
  }
})

test('5000-event replay keeps listener notifications bounded', () => {
  const prevRaf = g.requestAnimationFrame
  const frames: Array<() => void> = []
  g.requestAnimationFrame = (cb) => {
    frames.push(cb)
    return frames.length
  }
  __setHubFallbackFlushMs(60_000)
  const events = Array.from({ length: 5000 }, (_, index) => ({
    seq: index + 1,
    ts: 0,
    type: 'text_delta',
    data: { text: 'x' },
  } as SessionEvent))
  const fake = makeFakeTransport(events)
  __setHubTransport(fake)
  let notifications = 0
  let unsub: (() => void) | undefined
  try {
    unsub = subscribeSession('s-5000', () => { notifications++ })
    while (frames.length > 0) frames.shift()!()
    assert.equal(getSessionSnapshot('s-5000').lastSeq, 5000)
    assert.ok(notifications <= 101, `5000 events should notify at most 101 times, got ${notifications}`)
  } finally {
    unsub?.()
    g.requestAnimationFrame = prevRaf
    __setHubFallbackFlushMs(250)
    __resetHubTransport()
  }
})

test('manual retry resumes from the highest folded seq and replays a dropped pending tail once', () => {
  const prevRaf = g.requestAnimationFrame
  const frames: Array<() => void> = []
  g.requestAnimationFrame = (cb) => {
    frames.push(cb)
    return frames.length
  }
  __setHubFallbackFlushMs(60_000)
  const events = Array.from({ length: 1000 }, (_, index) => ({
    seq: index + 1,
    ts: 0,
    type: 'text_delta',
    data: { text: 'x' },
  } as SessionEvent))
  const sinces: number[] = []
  const streamSession = (
    _id: string,
    since: number,
    onEvent: (event: SessionEvent) => void,
    signal: AbortSignal,
    onOpen?: () => void,
  ): Promise<void> => {
    sinces.push(since)
    onOpen?.()
    for (const event of events) {
      if (event.seq > since) onEvent(event)
    }
    return new Promise<void>((_resolve, reject) => {
      signal.addEventListener(
        'abort',
        () => reject(new DOMException('aborted', 'AbortError')),
        { once: true },
      )
    })
  }
  __setHubTransport({
    streamSession,
    fetchEvents: async () => ({ events: [], lastSeq: 0 }),
  })
  let unsub: (() => void) | undefined
  try {
    unsub = subscribeSession('s-retry-tail', () => {})
    frames.shift()!()
    const partial = getSessionSnapshot('s-retry-tail')
    assert.equal(partial.lastSeq, 400)
    assert.equal(partial.blocks[0]!.text.length, 400)

    // The queued old-generation frame is canceled by retry; remove it from the
    // deterministic frame harness to model cancelAnimationFrame.
    frames.length = 0
    partial.retryStream()
    while (frames.length > 0) frames.shift()!()

    const final = getSessionSnapshot('s-retry-tail')
    assert.deepEqual(sinces, [0, 400], 'retry must resume after the folded prefix, not received tail')
    assert.equal(final.lastSeq, 1000)
    assert.equal(final.blocks[0]!.text.length, 1000, 'replayed tail must fold exactly once')
  } finally {
    unsub?.()
    g.requestAnimationFrame = prevRaf
    __setHubFallbackFlushMs(250)
    __resetHubTransport()
  }
})

test('last unsubscribe tears down the stream and evicts the store', async () => {
  const fake = makeFakeTransport([])
  __setHubTransport(fake)
  try {
    const unsubA = subscribeSession('s-evict', () => {})
    const unsubB = subscribeSession('s-evict', () => {})
    await tick()
    assert.equal(__activeStoreCount(), 1)
    unsubA()
    assert.equal(__activeStoreCount(), 1, 'store survives while one subscriber remains')
    assert.equal(fake.state.signals[0]!.aborted, false)
    unsubB()
    assert.equal(__activeStoreCount(), 0, 'store evicted after the last subscriber')
    assert.equal(fake.state.signals[0]!.aborted, true, 'stream aborted on teardown')
  } finally {
    __resetHubTransport()
  }
})
