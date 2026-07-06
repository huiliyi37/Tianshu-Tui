import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  CdpConnection,
  discoverBrowser,
  listTargets,
  openTarget,
  probeEndpoint,
  type CdpTransport,
  type CdpTransportFactory,
  type CdpTransportHandlers,
  type FetchLike,
} from '../cdp/client.js'

// ── fake transport ──────────────────────────────────────────────────

interface SentMessage {
  id: number
  method: string
  params: Record<string, unknown>
  sessionId?: string
}

class FakeTransport implements CdpTransport {
  sent: SentMessage[] = []
  closed = false
  handlers!: CdpTransportHandlers

  send(data: string): void {
    this.sent.push(JSON.parse(data) as SentMessage)
  }
  close(): void {
    this.closed = true
  }
  /** Push a raw CDP frame to the client. */
  emit(frame: Record<string, unknown>): void {
    this.handlers.onMessage(JSON.stringify(frame))
  }
  reply(id: number, result: Record<string, unknown>): void {
    this.emit({ id, result })
  }
  replyError(id: number, message: string): void {
    this.emit({ id, error: { message } })
  }
}

function fakeFactory(transport: FakeTransport): CdpTransportFactory {
  return async (_url, handlers) => {
    transport.handlers = handlers
    return transport
  }
}

async function connect(): Promise<{ conn: CdpConnection; transport: FakeTransport }> {
  const transport = new FakeTransport()
  const conn = await CdpConnection.connect('ws://fake', fakeFactory(transport))
  return { conn, transport }
}

// ── request correlation ─────────────────────────────────────────────

test('cdp client: correlates out-of-order responses by id', async () => {
  const { conn, transport } = await connect()
  const p1 = conn.send<{ v: string }>('Domain.first')
  const p2 = conn.send<{ v: string }>('Domain.second')
  assert.equal(transport.sent.length, 2)
  const [m1, m2] = transport.sent
  // Answer in reverse order — each promise must still get ITS result.
  transport.reply(m2!.id, { v: 'two' })
  transport.reply(m1!.id, { v: 'one' })
  assert.deepEqual(await p1, { v: 'one' })
  assert.deepEqual(await p2, { v: 'two' })
  conn.close()
})

test('cdp client: error responses reject with method name', async () => {
  const { conn, transport } = await connect()
  const p = conn.send('DOM.getContentQuads', { backendNodeId: 5 })
  transport.replyError(transport.sent[0]!.id, 'No node found')
  await assert.rejects(p, /CDP DOM\.getContentQuads failed: No node found/)
  conn.close()
})

test('cdp client: per-request timeout fires and cleans up', async () => {
  const { conn } = await connect()
  const p = conn.send('Slow.method', {}, { timeoutMs: 20 })
  await assert.rejects(p, /CDP request timeout \(20ms\): Slow\.method/)
  conn.close()
})

test('cdp client: sessionId rides on the wire and is optional', async () => {
  const { conn, transport } = await connect()
  const p = conn.send('Page.enable', {}, { sessionId: 'sess-42' })
  const msg = transport.sent[0]!
  assert.equal(msg.sessionId, 'sess-42')
  transport.reply(msg.id, {})
  await p
  const p2 = conn.send('Target.getTargets')
  assert.equal(transport.sent[1]!.sessionId, undefined)
  transport.reply(transport.sent[1]!.id, {})
  await p2
  conn.close()
})

// ── events ──────────────────────────────────────────────────────────

test('cdp client: events route to handlers with sessionId; unsubscribe works', async () => {
  const { conn, transport } = await connect()
  const seen: Array<{ params: Record<string, unknown>; sessionId: string | undefined }> = []
  const off = conn.on('Page.loadEventFired', (params, sessionId) => seen.push({ params, sessionId }))
  transport.emit({ method: 'Page.loadEventFired', params: { timestamp: 1 }, sessionId: 'sess-1' })
  transport.emit({ method: 'Other.event', params: {} })
  assert.equal(seen.length, 1)
  assert.equal(seen[0]!.sessionId, 'sess-1')
  off()
  transport.emit({ method: 'Page.loadEventFired', params: { timestamp: 2 } })
  assert.equal(seen.length, 1)
  conn.close()
})

test('cdp client: waitForEvent resolves on predicate match, times out otherwise', async () => {
  const { conn, transport } = await connect()
  const wait = conn.waitForEvent('Page.loadEventFired', (_p, sessionId) => sessionId === 'main', 1_000)
  transport.emit({ method: 'Page.loadEventFired', params: {}, sessionId: 'other' })
  transport.emit({ method: 'Page.loadEventFired', params: { t: 9 }, sessionId: 'main' })
  const got = await wait
  assert.equal(got.t, 9)
  await assert.rejects(
    conn.waitForEvent('Never.event', () => true, 20),
    /CDP event timeout \(20ms\): Never\.event/,
  )
  conn.close()
})

// ── lifecycle ───────────────────────────────────────────────────────

test('cdp client: close() rejects in-flight requests and blocks new sends', async () => {
  const { conn } = await connect()
  const inflight = conn.send('Hang.forever')
  conn.close()
  await assert.rejects(inflight, /CDP connection closed \(in-flight: Hang\.forever\)/)
  await assert.rejects(conn.send('After.close'), /CDP connection is closed/)
  assert.equal(conn.isClosed, true)
})

test('cdp client: remote close rejects in-flight requests', async () => {
  const { conn, transport } = await connect()
  const inflight = conn.send('Hang.forever')
  transport.handlers.onClose()
  await assert.rejects(inflight, /CDP connection closed by remote/)
  assert.equal(conn.isClosed, true)
})

// ── HTTP discovery ──────────────────────────────────────────────────

function fakeFetch(routes: Record<string, { status?: number; body: unknown } | ((method: string) => { status?: number; body: unknown })>): FetchLike {
  return async (url, init) => {
    const key = Object.keys(routes).find((k) => url.includes(k))
    if (!key) return { ok: false, status: 404, json: async () => ({}), text: async () => 'not found' }
    const route = routes[key]!
    const spec = typeof route === 'function' ? route(init?.method ?? 'GET') : route
    const status = spec.status ?? 200
    return { ok: status >= 200 && status < 300, status, json: async () => spec.body, text: async () => JSON.stringify(spec.body) }
  }
}

test('cdp discovery: /json/version yields browser WS url; missing url throws', async () => {
  const ok = fakeFetch({ '/json/version': { body: { webSocketDebuggerUrl: 'ws://x/devtools/browser/1', Browser: 'Chrome/140' } } })
  const info = await discoverBrowser('http://h:1', ok)
  assert.equal(info.webSocketDebuggerUrl, 'ws://x/devtools/browser/1')
  assert.equal(info.browser, 'Chrome/140')
  const noUrl = fakeFetch({ '/json/version': { body: { Browser: 'Chrome/140' } } })
  await assert.rejects(discoverBrowser('http://h:1', noUrl), /exposes no webSocketDebuggerUrl/)
})

test('cdp discovery: listTargets returns array (or empty on junk)', async () => {
  const targets = [{ id: 'T1', type: 'page', title: 'Tab', url: 'https://a' }]
  assert.deepEqual(await listTargets('http://h:1', fakeFetch({ '/json/list': { body: targets } })), targets)
  assert.deepEqual(await listTargets('http://h:1', fakeFetch({ '/json/list': { body: { nope: 1 } } })), [])
})

test('cdp discovery: openTarget tries PUT first, falls back to GET (pre-111 Chromium)', async () => {
  const methods: string[] = []
  const fetchImpl = fakeFetch({
    '/json/new': (method) => {
      methods.push(method)
      // Old Chromium: PUT rejected, GET accepted.
      if (method === 'PUT') return { status: 405, body: {} }
      return { body: { id: 'T9', type: 'page', title: '', url: 'about:blank' } }
    },
  })
  const created = await openTarget('http://h:1', 'about:blank', fetchImpl)
  assert.equal(created.id, 'T9')
  assert.deepEqual(methods, ['PUT', 'GET'])
})

test('cdp discovery: probeEndpoint is a boolean health check', async () => {
  assert.equal(await probeEndpoint('http://h:1', fakeFetch({ '/json/version': { body: { webSocketDebuggerUrl: 'ws://x' } } })), true)
  assert.equal(await probeEndpoint('http://h:1', fakeFetch({})), false)
  const throwing: FetchLike = async () => { throw new Error('ECONNREFUSED') }
  assert.equal(await probeEndpoint('http://h:1', throwing), false)
})
