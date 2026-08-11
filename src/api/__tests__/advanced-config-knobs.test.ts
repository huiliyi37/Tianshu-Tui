/**
 * OPT-003 建议 1–3：provider 级高级配置（advanced）的运行时消费点。
 *
 * 覆盖四个消费面：
 * - temperature：provider 级默认温度注入（openai 思考模式不注入；anthropic 无
 *   thinking budget 时注入并 clamp 到 0–1）
 * - maxRetries：覆盖内置重试默认（0 = 禁用重试）
 * - requestTimeoutMs：严格总时限——到时即抛错（即使流仍在产出，不做进度续期）
 * - proxy：undici ProxyAgent 经 fetchWithTimeout 的 dispatcher 槽位透传
 */

import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ProxyAgent } from 'undici'
import { OpenAIClient, type OpenAIClientConfig } from '../openai-client.js'
import { AnthropicClient } from '../anthropic-client.js'
import type { OaiChatRequest } from '../oai-types.js'
import type { StreamCallbacks } from '../stream-client.js'

const BASE: Omit<OpenAIClientConfig, 'model'> = {
  baseUrl: 'https://api.example.com/v1',
  apiKey: 'sk-test',
  maxTokens: 1024,
}

const REQUEST: OaiChatRequest = {
  model: 'test-model',
  messages: [{ role: 'user', content: 'hi' }],
  max_tokens: 64,
}

const NOOP: StreamCallbacks = {
  onTextDelta: () => {},
  onThinkingDelta: () => {},
  onContentBlock: () => {},
  onStopReason: () => {},
  onError: () => {},
}

const encoder = new TextEncoder()

function doneStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: [DONE]\n\n'))
      c.close()
    },
  })
}

/** Hang after one content chunk — used to force the hard cap to fire mid-read. */
function oneChunkThenHangStream(): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(c) {
      c.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"x"},"index":0}]}\n\n'))
      // never close — the stream "keeps going"
    },
  })
}

function sseResponse(stream: ReadableStream<Uint8Array>): Response {
  return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** Install a capturing mock fetch; returns captured inits and a restore fn. */
function mockFetch(makeResponse: () => Response): {
  inits: Array<Record<string, unknown>>
  restore: () => void
} {
  const inits: Array<Record<string, unknown>> = []
  const original = globalThis.fetch
  globalThis.fetch = mock.fn(async (_url: string | URL | Request, init?: RequestInit) => {
    inits.push((init ?? {}) as Record<string, unknown>)
    return makeResponse()
  }) as unknown as typeof fetch
  return { inits, restore: () => { globalThis.fetch = original } }
}

describe('advanced.temperature consumption', () => {
  it('OpenAI: provider-level temperature becomes the request default', async () => {
    const m = mockFetch(() => sseResponse(doneStream()))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', temperature: 0.3 })
      await client.stream(REQUEST, NOOP)
      const body = JSON.parse(m.inits[0]!.body as string)
      assert.equal(body.temperature, 0.3)
    } finally { m.restore() }
  })

  it('OpenAI: per-request temperature takes precedence', async () => {
    const m = mockFetch(() => sseResponse(doneStream()))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', temperature: 0.3 })
      await client.stream({ ...REQUEST, temperature: 0.7 }, NOOP)
      const body = JSON.parse(m.inits[0]!.body as string)
      assert.equal(body.temperature, 0.7)
    } finally { m.restore() }
  })

  it('OpenAI: NOT injected when thinking is enabled (inference servers reject it)', async () => {
    const m = mockFetch(() => sseResponse(doneStream()))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', temperature: 0.3, thinking: 'enabled' })
      await client.stream(REQUEST, NOOP)
      const body = JSON.parse(m.inits[0]!.body as string)
      assert.equal(body.temperature, undefined)
    } finally { m.restore() }
  })

  it('Anthropic: injected and clamped to 0–1 when no thinking budget', () => {
    const hi = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxTokens: 100, temperature: 1.5 })
    assert.equal(hi.buildRequestBodyForTest(REQUEST).temperature, 1)
    const lo = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxTokens: 100, temperature: -0.5 })
    assert.equal(lo.buildRequestBodyForTest(REQUEST).temperature, 0)
  })

  it('Anthropic: NOT injected when thinking budget is set (API requires temperature=1)', () => {
    const client = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxTokens: 100, temperature: 0.2, thinkingBudget: 1024 })
    const body = client.buildRequestBodyForTest(REQUEST)
    assert.equal(body.temperature, undefined)
    assert.deepEqual(body.thinking, { type: 'enabled', budget_tokens: 1024 })
  })
})

describe('advanced.maxRetries consumption', () => {
  it('maxRetries: 0 disables retries entirely (single fetch for a retryable 500)', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', maxRetries: 0 })
      await assert.rejects(() => client.stream(REQUEST, NOOP))
      assert.equal(m.inits.length, 1)
    } finally { m.restore() }
  })

  it('maxRetries: 1 caps a retryable 500 at exactly one retry', async () => {
    const m = mockFetch(() => new Response(JSON.stringify({ error: { message: 'boom' } }), { status: 500 }))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', maxRetries: 1 })
      await assert.rejects(() => client.stream(REQUEST, NOOP))
      assert.equal(m.inits.length, 2)
    } finally { m.restore() }
  })
})

describe('advanced.requestTimeoutMs consumption', () => {
  it('acts as a strict per-attempt cap — fires even while the stream is still producing', async () => {
    const m = mockFetch(() => sseResponse(oneChunkThenHangStream()))
    try {
      // maxRetries: 0 keeps the test on a single attempt; the timeout error
      // message would otherwise be retryable and the test would loop.
      const client = new OpenAIClient({ ...BASE, model: 'm', requestTimeoutMs: 250, maxRetries: 0 })
      await assert.rejects(
        () => client.stream(REQUEST, NOOP),
        (err: unknown) => {
          assert.match((err as Error).message, /requestTimeoutMs/)
          assert.match((err as Error).message, /exceeded configured limit/)
          return true
        },
      )
    } finally { m.restore() }
  })
})

describe('advanced.proxy consumption', () => {
  it('materializes a ProxyAgent and passes it as the fetch dispatcher', async () => {
    const m = mockFetch(() => sseResponse(doneStream()))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm', proxy: 'http://127.0.0.1:7890' })
      await client.stream(REQUEST, NOOP)
      assert.ok(m.inits[0]!.dispatcher instanceof ProxyAgent)
    } finally { m.restore() }
  })

  it('no proxy → no dispatcher (default fetch routing)', async () => {
    const m = mockFetch(() => sseResponse(doneStream()))
    try {
      const client = new OpenAIClient({ ...BASE, model: 'm' })
      await client.stream(REQUEST, NOOP)
      assert.equal(m.inits[0]!.dispatcher, undefined)
    } finally { m.restore() }
  })

  it('Anthropic client also wires the proxy dispatcher', () => {
    const withProxy = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxTokens: 100, proxy: 'http://127.0.0.1:7890' })
    assert.ok((withProxy as unknown as { proxyDispatcher: unknown }).proxyDispatcher instanceof ProxyAgent)
    const without = new AnthropicClient({ baseUrl: 'https://api.anthropic.com', apiKey: 'k', model: 'c', maxTokens: 100 })
    assert.equal((without as unknown as { proxyDispatcher: unknown }).proxyDispatcher, undefined)
  })
})
