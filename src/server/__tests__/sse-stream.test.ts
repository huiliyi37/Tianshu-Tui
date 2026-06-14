import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { ServerResponse } from 'node:http'
import { SseStream } from '../sse-stream.js'

/** Minimal ServerResponse stand-in capturing writes and end()/throws. */
function fakeRes(opts: { throwOnWrite?: boolean } = {}) {
  const writes: string[] = []
  let ended = false
  const res = {
    writeHead() {},
    write(chunk: string) {
      if (opts.throwOnWrite) throw new Error('EPIPE')
      writes.push(chunk)
      return true
    },
    end() {
      ended = true
    },
  }
  return { res: res as unknown as ServerResponse, writes, isEnded: () => ended }
}

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
