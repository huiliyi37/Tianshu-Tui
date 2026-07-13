import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager } from '../session-manager.js'
import type { ManagedAgent } from '../session-manager.js'
import type { ServerResponse } from 'node:http'

type AgentCallbacks = Parameters<ManagedAgent['run']>[1]

const TOKEN = 'secret-token'
const AUTH = { authorization: `Bearer ${TOKEN}` }

/** Minimal ServerResponse that records all writes. Supports cork/uncork. */
function mockRes() {
  const writes: string[] = []
  let corked = false
  let corkBuffer: string[] = []
  const res = {
    writeHead() {},
    write(chunk: string) {
      if (corked) corkBuffer.push(chunk)
      else writes.push(chunk)
      return true
    },
    end() {},
    cork() { corked = true },
    uncork() {
      corked = false
      if (corkBuffer.length > 0) {
        writes.push(corkBuffer.join(''))
        corkBuffer = []
      }
    },
    on() {},
    writableEnded: false,
  }
  return { res: res as unknown as ServerResponse, writes }
}

/** Parse SSE frames from accumulated writes into seq numbers. */
function parseSeqs(writes: string[]): number[] {
  const seqs: number[] = []
  for (const w of writes) {
    for (const m of w.matchAll(/"seq":(\d+)/g)) seqs.push(Number(m[1]))
  }
  return seqs
}

function setup() {
  const agents: FakeAgent[] = []
  const manager = new RuntimeSessionManager({
    createAgent: () => {
      const agent = new FakeAgent()
      agents.push(agent)
      return agent
    },
    defaultCwd: '/tmp/work',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  return { manager, routes, agents }
}

class FakeAgent {
  callbacks?: AgentCallbacks
  run(_prompt: string, callbacks: AgentCallbacks) {
    this.callbacks = callbacks
    return new Promise<void>(() => {})
  }
  abort() {}
  enableTool() { return { status: 'mounted', cacheImpact: 'none' } as const }
  setActivePlan() {}
  enterPlanMode() {}
  switchModel(m: string): string | null { return m }
  getActivePlanFilePath() { return null }
  listArtifacts() { return [] }
  readArtifact() { return Promise.resolve(null) }
  getMessages() { return [] }
  replaceMessages() {}
  rewindToMessages() {}
  getReasoningEffort() { return 'medium' }
  setReasoningEffort() {}
}

test('replay preserves event order across batches (5000 events)', async () => {
  const { manager, routes } = setup()
  // Create WITHOUT prompt to avoid auto-run events
  const created = await routes['POST /sessions']!({ title: 'T' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  // Inject events directly into the session's in-memory log
  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  for (let i = 1; i <= 5000; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `t${i}` } })
  }

  const { res, writes } = mockRes()
  const handler = routes['GET /sessions/:id/stream']!
  await handler({}, { id, since: '0' }, AUTH, res)

  const seqs = parseSeqs(writes)
  assert.equal(seqs.length, 5000, `all replay events must be sent, got ${seqs.length}`)
  assert.ok(writes.length >= 25, `5000 events require at least 25 corked slices, got ${writes.length}`)
  assert.ok(
    writes.every((write) => parseSeqs([write]).length <= 200),
    'no replay slice may exceed 200 events',
  )
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i + 1, `position ${i}: expected seq ${i + 1}, got ${seqs[i]}`)
  }
})

test('gap backfill is time-sliced and buffers live events in order', async () => {
  const { manager, routes } = setup()
  const created = await routes['POST /sessions']!({ title: 'T' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  // Seed enough events to span multiple batches (REPLAY_BATCH=200).
  // The first 200 go into the replay snapshot; they'll be sent in batch 1.
  // The yield (setImmediate) after batch 1 is the gap window.
  for (let i = 1; i <= 250; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `t${i}` } })
  }

  // First yield: append a 500-event gap before subscribe. Second yield: append
  // one live event after subscribe while the gap itself is being replayed.
  const origSetImmediate = globalThis.setImmediate
  let yields = 0
  globalThis.setImmediate = ((cb: (...args: unknown[]) => void) => {
    yields++
    if (yields === 1) {
      for (let i = 0; i < 500; i++) {
        s.seq++
        s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `gap-${i}` } })
      }
    } else if (yields === 2) {
      const appendRaw = (manager as unknown as {
        appendRaw: (
          session: typeof s,
          type: string,
          data: Record<string, unknown>,
        ) => void
      }).appendRaw.bind(manager)
      appendRaw(s, 'status', { status: 'running' })
    }
    return origSetImmediate(cb)
  }) as typeof globalThis.setImmediate

  try {
    const { res, writes } = mockRes()
    const handler = routes['GET /sessions/:id/stream']!
    await handler({}, { id, since: '0' }, AUTH, res)

    const seqs = parseSeqs(writes)
    const seen = new Set<number>()
    for (const seq of seqs) {
      assert.ok(!seen.has(seq), `seq ${seq} duplicated`)
      seen.add(seq)
    }
    assert.ok(yields >= 3, `initial replay plus 500-event gap should yield at least 3 times, got ${yields}`)
    // 250 seed + 500 pre-subscribe gap + 1 live event during gap replay.
    assert.equal(seqs.length, 751, `expected 751 ordered events, got ${seqs.length}`)
    for (let i = 0; i < 751; i++) {
      assert.equal(seqs[i], i + 1, `position ${i}: expected seq ${i + 1}, got ${seqs[i]}`)
    }
  } finally {
    globalThis.setImmediate = origSetImmediate
  }
})

test('delta flushed by getEvents after subscribe is not duplicated by gap replay', async () => {
  const { manager, routes, agents } = setup()
  const created = await routes['POST /sessions']!({ title: 'delta race', prompt: 'start' }, {}, AUTH)
  const id = (created.body as { id: string }).id
  const callbacks = agents[0]!.callbacks!

  // First delta lands immediately and opens the coalescing run. The next delta,
  // emitted during replay, stays in deltaBuf until getEvents() flushes it after
  // the route has subscribed — so listener and gap snapshot observe the same seq.
  callbacks.onTextDelta('head')
  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  for (let i = 0; i < 250; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'status', data: { status: 'running' } })
  }

  const origSetImmediate = globalThis.setImmediate
  let buffered = false
  globalThis.setImmediate = ((cb: (...args: unknown[]) => void) => {
    if (!buffered) {
      buffered = true
      callbacks.onTextDelta(' tail')
    }
    return origSetImmediate(cb)
  }) as typeof globalThis.setImmediate

  try {
    const { res, writes } = mockRes()
    await routes['GET /sessions/:id/stream']!({}, { id, since: '0' }, AUTH, res)
    const seqs = parseSeqs(writes)
    assert.equal(new Set(seqs).size, seqs.length, 'the flushed delta seq must be sent exactly once')
    assert.deepEqual(seqs, [...seqs].sort((a, b) => a - b), 'catch-up output must stay globally ordered')
    assert.equal(seqs.at(-1), s.seq)
  } finally {
    globalThis.setImmediate = origSetImmediate
  }
})

test('replay with 0 events completes cleanly', async () => {
  const { routes } = setup()
  const created = await routes['POST /sessions']!({ title: 'empty' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  const { res, writes } = mockRes()
  const handler = routes['GET /sessions/:id/stream']!
  await handler({}, { id, since: '0' }, AUTH, res)

  const seqs = parseSeqs(writes)
  assert.equal(seqs.length, 0)
})

test('sub-batch-size replay sends all events', async () => {
  const { manager, routes } = setup()
  const created = await routes['POST /sessions']!({ title: 'T' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  for (let i = 1; i <= 50; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `t${i}` } })
  }

  const { res, writes } = mockRes()
  const handler = routes['GET /sessions/:id/stream']!
  await handler({}, { id, since: '0' }, AUTH, res)

  const seqs = parseSeqs(writes)
  assert.equal(seqs.length, 50)
  for (let i = 0; i < 50; i++) assert.equal(seqs[i], i + 1)
})

test('replay yields when a sub-200 event slice exceeds the time budget', async () => {
  const { manager, routes } = setup()
  const created = await routes['POST /sessions']!({ title: 'slow writes' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  for (let i = 1; i <= 20; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `t${i}` } })
  }

  const { res, writes } = mockRes()
  const originalWrite = res.write.bind(res)
  res.write = ((chunk: string) => {
    const until = performance.now() + 0.75
    while (performance.now() < until) {
      // Deliberately simulate a slow socket/serialization path.
    }
    return originalWrite(chunk)
  }) as typeof res.write

  const origSetImmediate = globalThis.setImmediate
  let yields = 0
  globalThis.setImmediate = ((cb: (...args: unknown[]) => void) => {
    yields++
    return origSetImmediate(cb)
  }) as typeof globalThis.setImmediate

  try {
    const handler = routes['GET /sessions/:id/stream']!
    await handler({}, { id, since: '0' }, AUTH, res)
  } finally {
    globalThis.setImmediate = origSetImmediate
  }

  assert.ok(yields >= 1, `time-bounded replay should yield at least once, got ${yields}`)
  assert.deepEqual(parseSeqs(writes), Array.from({ length: 20 }, (_, i) => i + 1))
})

test('replay stops writing and uncorks when the peer dies mid-slice', async () => {
  const { manager, routes } = setup()
  const created = await routes['POST /sessions']!({ title: 'dead peer' }, {}, AUTH)
  const id = (created.body as { id: string }).id

  const internal = manager as unknown as { sessions: Map<string, { events: Array<{ seq: number; ts: number; type: string; data: Record<string, unknown> }>; seq: number }> }
  const s = internal.sessions.get(id)!
  for (let i = 1; i <= 100; i++) {
    s.seq++
    s.events.push({ seq: s.seq, ts: Date.now(), type: 'text_delta', data: { text: `t${i}` } })
  }

  const { res, writes } = mockRes()
  const originalWrite = res.write.bind(res)
  const originalUncork = res.uncork.bind(res)
  let writeCalls = 0
  let uncorkCalls = 0
  res.write = ((chunk: string) => {
    writeCalls++
    if (writeCalls === 3) throw new Error('EPIPE')
    return originalWrite(chunk)
  }) as typeof res.write
  res.uncork = (() => {
    uncorkCalls++
    originalUncork()
  }) as typeof res.uncork

  const handler = routes['GET /sessions/:id/stream']!
  await handler({}, { id, since: '0' }, AUTH, res)

  assert.equal(writeCalls, 3, 'closed replay must stop attempting writes')
  assert.equal(uncorkCalls, 1, 'the interrupted slice must still be uncorked')
  assert.deepEqual(parseSeqs(writes), [1, 2])
})
