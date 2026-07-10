import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { SseStream } from '../sse-stream.js'

/** Minimal ServerResponse stand-in capturing writes and end()/throws. */
function fakeRes(opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = []
  let ended = false
  let headers: Record<string, unknown> = {}
  const res = {
    writeHead(_status: number, h?: Record<string, unknown>) {
      if (h) headers = h
    },
    write(chunk: string) {
      if (opts.throwOnWrite) throw new Error('EPIPE')
      writes.push(chunk)
      return true
    },
    end() {
      ended = true
    },
  }
  return { res: res as unknown as ServerResponse, writes, isEnded: () => ended, getHeaders: () => headers }
}

test('sets text/event-stream + CORS headers so the Tauri webview is not blocked', () => {
  const { res, getHeaders } = fakeRes()
  new SseStream(res)
  const h = getHeaders()
  assert.equal(h['Content-Type'], 'text/event-stream')
  // Regression: the SSE response bypasses the router's CORS header (handled:true),
  // so it must set Access-Control-Allow-Origin itself — otherwise the cross-origin
  // webview blocks the stream and the client loops forever on "reconnecting".
  assert.equal(h['Access-Control-Allow-Origin'], '*')
})

test('send emits an SSE event frame', () => {
  const { res, writes } = fakeRes()
  const sse = new SseStream(res)
  sse.send('tool_use', { seq: 1 })
  assert.equal(writes.length, 1)
  assert.equal(writes[0], 'event: tool_use\ndata: {"seq":1}\n\n')
})

test('ping writes a comment heartbeat ignored by EventSource', () => {
  const { res, writes } = fakeRes()
  const sse = new SseStream(res)
  sse.ping()
  assert.equal(writes[0], ': ping\n\n')
})

test('close is idempotent and ends the response once', () => {
  const { res, writes, isEnded } = fakeRes()
  const sse = new SseStream(res)
  sse.close()
  sse.close()
  assert.equal(isEnded(), true)
  // exactly one 'done' frame despite the double close
  assert.equal(writes.filter((w) => w.startsWith('event: done')).length, 1)
})

test('send after close is a no-op', () => {
  const { res, writes } = fakeRes()
  const sse = new SseStream(res)
  sse.close()
  const before = writes.length
  sse.send('tool_use', { seq: 2 })
  assert.equal(writes.length, before)
})

test('a dead peer (write throws) closes the stream instead of crashing', () => {
  const { res } = fakeRes({ throwOnWrite: true })
  const sse = new SseStream(res)
  assert.doesNotThrow(() => sse.send('tool_use', { seq: 1 }))
  assert.equal(sse.isClosed(), true)
  // once closed, further writes short-circuit (no throw)
  assert.doesNotThrow(() => sse.ping())
})

test('onDead fires exactly once when the peer dies, letting the owner unsubscribe', () => {
  const { res } = fakeRes({ throwOnWrite: true })
  let deadCount = 0
  const sse = new SseStream(res, () => { deadCount += 1 })
  sse.send('tool_use', { seq: 1 })
  sse.send('tool_use', { seq: 2 })
  sse.ping()
  assert.equal(deadCount, 1, 'owner cleanup must run once, not per failed write')
})

test('onDead does NOT fire on a local intentional close()', () => {
  const { res } = fakeRes()
  let deadCount = 0
  const sse = new SseStream(res, () => { deadCount += 1 })
  sse.close()
  assert.equal(deadCount, 0, 'intentional close has its own cleanup path')
})

test('a throwing onDead callback never crashes the write path', () => {
  const { res } = fakeRes({ throwOnWrite: true })
  const sse = new SseStream(res, () => { throw new Error('owner bug') })
  assert.doesNotThrow(() => sse.send('tool_use', { seq: 1 }))
  assert.equal(sse.isClosed(), true)
})
