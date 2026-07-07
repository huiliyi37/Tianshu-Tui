/**
 * 4e1aaa21 post-mortem (Phase 2/3):
 *
 * 1. Body-phase TimeoutError (raw undici DOMException from an AbortSignal.timeout
 *    that aborts the fetch mid-stream) must surface as a descriptive, classifiable
 *    Error — not "The operation was aborted due to timeout" verbatim.
 * 2. Every failed stream attempt that already received partial output must emit
 *    onStreamAttemptAborted with the discarded char count, so silent multi-minute
 *    reasoning losses become observable.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import type { StreamAttemptAbortedInfo } from '../stream-client.js'

const CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 1024,
}

const flush = () => new Promise<void>(r => setImmediate(r))

type ParseFn = (
  r: ReadableStreamDefaultReader<Uint8Array>,
  cb: Record<string, unknown>,
) => Promise<void>

function makeClientAndReader() {
  const client = new OpenAIClient(CONFIG)
  const enc = new TextEncoder()
  let ctl!: ReadableStreamDefaultController<Uint8Array>
  const stream = new ReadableStream<Uint8Array>({ start(c) { ctl = c } })
  const reader = new Response(stream).body!.getReader()
  const parse = (client as unknown as { parseStreamFromReader: ParseFn }).parseStreamFromReader.bind(client) as ParseFn
  return { client, enc, ctl, reader, parse }
}

describe('stream attempt aborted observability', () => {
  it('emits onStreamAttemptAborted with received chars when the stream errors mid-body', async () => {
    const { enc, ctl, reader, parse } = makeClientAndReader()

    let aborted: StreamAttemptAbortedInfo | null = null
    let err: Error | null = null
    const p = parse(reader, {
      onTextDelta() {},
      onStopReason() {},
      onStreamAttemptAborted(info: StreamAttemptAbortedInfo) { aborted = info },
    }).catch((e: Error) => { err = e })

    await flush()
    // Stream some reasoning + text, then error the stream mid-body.
    ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"reasoning_content":"thinking hard about it"},"index":0}]}\n\n'))
    await flush()
    ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"partial answer"},"index":0}]}\n\n'))
    await flush()
    ctl.error(new Error('connection reset by peer'))
    await flush()
    await p

    assert.ok(err, 'stream error must propagate')
    assert.ok(aborted, 'onStreamAttemptAborted must fire')
    const info = aborted as StreamAttemptAbortedInfo
    assert.equal(info.receivedChars, 'thinking hard about it'.length + 'partial answer'.length)
    assert.ok(info.elapsedMs >= 0)
    assert.match(info.errorMessage, /connection reset/)
  })

  it('wraps a raw body-phase TimeoutError into a descriptive classifiable error', async () => {
    const { enc, ctl, reader, parse } = makeClientAndReader()

    let err: Error | null = null
    const p = parse(reader, { onTextDelta() {}, onStopReason() {} })
      .catch((e: Error) => { err = e })

    await flush()
    ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"streaming"},"index":0}]}\n\n'))
    await flush()
    // Simulate undici aborting the body because an AbortSignal.timeout fired.
    ctl.error(new DOMException('The operation was aborted due to timeout', 'TimeoutError'))
    await flush()
    await p

    assert.ok(err, 'error must propagate')
    const e = err as unknown as Error
    assert.ok(!(e instanceof DOMException), 'raw DOMException must not leak')
    assert.match(e.message, /timed out mid-body/)
    assert.match(e.message, /OpenAI SSE stream/)
  })

  it('does not fire onStreamAttemptAborted on a clean stream', async () => {
    const { enc, ctl, reader, parse } = makeClientAndReader()

    let aborted: StreamAttemptAbortedInfo | null = null
    const p = parse(reader, {
      onTextDelta() {},
      onStopReason() {},
      onStreamAttemptAborted(info: StreamAttemptAbortedInfo) { aborted = info },
    })

    await flush()
    ctl.enqueue(enc.encode('data: {"choices":[{"delta":{"content":"hello"},"index":0}]}\n\n'))
    await flush()
    ctl.enqueue(enc.encode('data: [DONE]\n\n'))
    await flush()
    ctl.close()
    await flush()
    await p

    assert.equal(aborted, null, 'clean completion must not report an aborted attempt')
  })
})
