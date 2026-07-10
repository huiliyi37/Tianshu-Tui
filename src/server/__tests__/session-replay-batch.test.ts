import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildSessionRoutes } from '../session-routes.js'
import { RuntimeSessionManager } from '../session-manager.js'
import type { ServerResponse } from 'node:http'

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
  const manager = new RuntimeSessionManager({
    createAgent: () => new FakeAgent(),
    defaultCwd: '/tmp/work',
  })
  const routes = buildSessionRoutes(manager, TOKEN)
  return { manager, routes }
}

class FakeAgent {
  run() { return Promise.resolve() }
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
  for (let i = 0; i < seqs.length; i++) {
    assert.equal(seqs[i], i + 1, `position ${i}: expected seq ${i + 1}, got ${seqs[i]}`)
  }
})

test('events appended during replay yield gap are caught by backfill, not duplicated', async () => {
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

  // Intercept setImmediate to inject events during the yield gap — this is
  // the real risk path: getEventsAsync snapshot taken, then new events arrive
  // before subscribe() is called. The gap-fill (manager.getEvents(lastSeq))
  // must catch them exactly once.
  const origSetImmediate = globalThis.setImmediate
  let gapInjected = false
  globalThis.setImmediate = ((cb: (...args: unknown[]) => void) => {
    // Inject a new event during the FIRST yield only, before subscribe().
    if (!gapInjected) {
      gapInjected = true
      s.seq++
      s.events.push({ seq: s.seq, ts: Date.now(), type: 'status', data: { status: 'running' } })
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
    // 250 seed events + 1 gap-injected event = 251 total
    assert.equal(seqs.length, 251, `expected 251 events (250 seed + 1 gap), got ${seqs.length}`)
    // All 251 seqs present (1..251)
    for (let i = 0; i < 251; i++) {
      assert.equal(seqs[i], i + 1, `position ${i}: expected seq ${i + 1}, got ${seqs[i]}`)
    }
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
