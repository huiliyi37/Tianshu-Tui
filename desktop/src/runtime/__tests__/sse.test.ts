import { test } from 'node:test'
import assert from 'node:assert/strict'
import { streamSession } from '../sse.ts'
import { clearRuntimeCache } from '../client.ts'
import type { SessionEvent } from '../types.ts'

const realFetch = globalThis.fetch

/** Build a Response whose body streams the given UTF-8 chunks as an SSE feed. */
function sseResponse(chunks: string[], status = 200): Response {
  const encoder = new TextEncoder()
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const c of chunks) controller.enqueue(encoder.encode(c))
      controller.close()
    },
  })
  return new Response(body, { status })
}

function frame(seq: number, type: string, data: Record<string, unknown> = {}): string {
  return `event: ${type}\ndata: ${JSON.stringify({ seq, ts: 0, type, data })}\n\n`
}

test('streamSession fires onOpen once the body is handed back, before any data', async () => {
  clearRuntimeCache()
  let openedBeforeFirstEvent: boolean | null = null
  let sawEvent = false
  globalThis.fetch = (() => Promise.resolve(sseResponse([frame(1, 'status')]))) as typeof fetch
  try {
    await streamSession(
      's1',
      0,
      () => { sawEvent = true },
      new AbortController().signal,
      () => { openedBeforeFirstEvent = !sawEvent },
    )
    assert.equal(openedBeforeFirstEvent, true, 'onOpen runs before the first onEvent')
    assert.equal(sawEvent, true, 'the data frame still reaches onEvent')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('streamSession parses SSE frames split across chunk boundaries', async () => {
  clearRuntimeCache()
  const f = frame(7, 'text_delta', { text: 'hi' })
  // Split the frame mid-way so the reader must buffer across reads.
  const mid = Math.floor(f.length / 2)
  const events: SessionEvent[] = []
  globalThis.fetch = (() =>
    Promise.resolve(sseResponse([f.slice(0, mid), f.slice(mid)]))) as typeof fetch
  try {
    await streamSession('s1', 0, (e) => events.push(e), new AbortController().signal)
    assert.equal(events.length, 1)
    assert.equal(events[0]!.seq, 7)
    assert.equal(events[0]!.type, 'text_delta')
  } finally {
    globalThis.fetch = realFetch
  }
})

test('streamSession throws on a non-ok status (so the caller can reconnect)', async () => {
  clearRuntimeCache()
  globalThis.fetch = (() => Promise.resolve(sseResponse([], 503))) as typeof fetch
  try {
    await assert.rejects(() =>
      streamSession('s1', 0, () => {}, new AbortController().signal, () => {
        throw new Error('onOpen must not fire on a failed connect')
      }),
    )
  } finally {
    globalThis.fetch = realFetch
  }
})
