import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { ReadableStream } from 'node:stream/web'
import { ApiClient } from '../client.js'
import type { ContentBlock, Usage } from '../types.js'

function sseResponse(events: string[]): Response {
  const body = new ReadableStream({
    start(controller) {
      controller.enqueue(new TextEncoder().encode(events.join('')))
      controller.close()
    },
  })
  return new Response(body as unknown as ReadableStream, { status: 200 })
}

function textToolJsonEvents(): string[] {
  return [
    'event: content_block_start\n',
    'data: {"content_block":{"type":"text"}}\n\n',
    'event: content_block_delta\n',
    'data: {"delta":{"type":"text_delta","text":"{\\"name\\":\\"read_file\\",\\"input\\":{\\"file_path\\":\\"/tmp/a\\"}}"}}\n\n',
    'event: content_block_stop\n',
    'data: {}\n\n',
    'event: message_delta\n',
    'data: {"delta_stop_reason":"end_turn","usage":{}}\n\n',
  ]
}

describe('ApiClient provider capabilities', () => {
  it('extracts tool JSON from text only when provider enables the fallback', async () => {
    const originalFetch = globalThis.fetch
    const fetchMock = mock.fn(async () => sseResponse(textToolJsonEvents()))
    globalThis.fetch = fetchMock as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: true,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch
    assert.equal(blocks.some(block => block.type === 'tool_use'), true)
  })

  it('does not extract tool JSON when provider disables the fallback', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => sseResponse(textToolJsonEvents())) as unknown as typeof fetch

    const blocks: ContentBlock[] = []
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: block => blocks.push(block),
        onStopReason: () => {},
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch
    assert.equal(blocks.some(block => block.type === 'tool_use'), false)
  })

  it('propagates usage-only fallback events so cache telemetry is recorded', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => sseResponse([
      'data: {"usage":{"prompt_tokens":100,"completion_tokens":20,"prompt_cache_hit_tokens":80,"prompt_cache_miss_tokens":20}}\n\n',
    ])) as unknown as typeof fetch

    let stopReason = ''
    let stopUsage: Partial<Usage> = {}
    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
      mapUsage: raw => ({
        input_tokens: raw.prompt_tokens as number,
        output_tokens: raw.completion_tokens as number,
        cache_read_input_tokens: raw.prompt_cache_hit_tokens as number,
        cache_creation_input_tokens: raw.prompt_cache_miss_tokens as number,
      }),
    })

    await client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: (reason, usage) => { stopReason = reason; stopUsage = usage },
        onError: error => { throw error },
      },
    )

    globalThis.fetch = originalFetch
    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 80)
    assert.equal(stopUsage.cache_creation_input_tokens, 20)
  })
})

describe('ApiClient abort-aware retry', () => {
  it('aborts retry sleep immediately', async () => {
    const originalFetch = globalThis.fetch
    globalThis.fetch = mock.fn(async () => new Response('rate limited', { status: 429 })) as unknown as typeof fetch

    const client = new ApiClient({
      baseUrl: 'https://example.test',
      apiKey: 'test-key',
      model: 'test-model',
      maxTokens: 100,
      thinking: 'disabled',
      unsupported: [],
      hasToolJsonInContentBug: false,
    })
    const controller = new AbortController()
    const started = Date.now()

    const promise = client.stream(
      { model: 'test-model', messages: [{ role: 'user', content: 'x' }], max_tokens: 100, stream: true },
      {
        onTextDelta: () => {},
        onThinkingDelta: () => {},
        onContentBlock: () => {},
        onStopReason: () => {},
        onError: () => {},
      },
      controller.signal,
    )

    controller.abort()
    await assert.rejects(promise)
    globalThis.fetch = originalFetch
    assert.ok(Date.now() - started < 500)
  })
})
