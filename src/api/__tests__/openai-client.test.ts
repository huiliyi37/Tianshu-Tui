import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, parseOpenAIError, type OpenAIClientConfig } from '../openai-client.js'

const TEST_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 4096,
}

describe('OpenAIClient', () => {
  it('implements StreamClient interface', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    assert.equal(typeof client.stream, 'function')
    assert.equal(client.stream.length, 3)
  })
})

describe('parseStream / SSE parsing', () => {
  it('parses text deltas and stop reason', async () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"role":"assistant","content":""},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })

    const response = new Response(stream)

    const textParts: string[] = []
    let stopReason: string | undefined

    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (text: string) => textParts.push(text),
        onStopReason: (reason: string) => { stopReason = reason },
      },
    )

    assert.equal(textParts.join(''), 'Hello world')
    assert.equal(stopReason, 'end_turn')
  })

  it('handles empty stream', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)

    const textParts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: (text: string) => textParts.push(text) },
    )

    assert.equal(textParts.length, 0)
  })

  it('skips malformed SSE lines', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const encoder = new TextEncoder()
    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode('not-sse-data\n'))
        controller.enqueue(encoder.encode('data: {invalid json\n\n'))
        controller.enqueue(encoder.encode('data: {"choices":[{"delta":{"content":"OK"},"index":0}]}\n\n'))
        controller.enqueue(encoder.encode('data: [DONE]\n\n'))
        controller.close()
      },
    })
    const response = new Response(stream)

    const textParts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: (text: string) => textParts.push(text) },
    )

    assert.equal(textParts.join(''), 'OK')
  })
})

describe('tool_calls delta buffering', () => {
  it('accumulates fragmented tool_calls deltas into complete tool_use', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []
    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onContentBlock: (block: any) => contentBlocks.push(block),
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation": "NYC"}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].type, 'tool_use')
    assert.equal(contentBlocks[0].id, 'call_abc')
    assert.equal(contentBlocks[0].name, 'get_weather')
    assert.deepEqual(contentBlocks[0].input, { location: 'NYC' })
    assert.equal(stopReason, undefined)

    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20 } },
      callbacks,
    )

    assert.equal(stopReason, 'tool_use')
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('handles multiple tool calls in one turn', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const contentBlocks: any[] = []

    client.processDelta(
      {
        choices: [{
          delta: {
            tool_calls: [
              { index: 0, id: 'call_1', type: 'function', function: { name: 'get_time', arguments: '{"tz":"UTC"}' } },
              { index: 1, id: 'call_2', type: 'function', function: { name: 'get_date', arguments: '{"tz":"UTC"}' } },
            ],
          },
          finish_reason: 'tool_calls',
        }],
      },
      { onContentBlock: (block: any) => contentBlocks.push(block) },
    )

    assert.equal(contentBlocks.length, 2)
    assert.equal(contentBlocks[0].name, 'get_time')
    assert.equal(contentBlocks[1].name, 'get_date')
  })

  it('handles text content before tool calls', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const contentBlocks: any[] = []

    client.processDelta(
      { choices: [{ delta: { content: 'Let me check the weather' }, finish_reason: null }] },
      { onTextDelta: (t: string) => texts.push(t), onContentBlock: (block: any) => contentBlocks.push(block) },
    )
    assert.equal(texts.join(''), 'Let me check the weather')

    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
      { onTextDelta: (t: string) => texts.push(t), onContentBlock: (block: any) => contentBlocks.push(block) },
    )
    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].name, 'get_weather')
  })

  it('emits stop reason with usage from final chunk', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    client.processDelta(
      { usage: { prompt_tokens: 50, completion_tokens: 10 } },
      callbacks,
    )
    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.input_tokens, 50)
    assert.equal(stopUsage.output_tokens, 10)
  })

  it('falls back to empty usage when no usage chunk arrives', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    assert.equal(stopReason, undefined)
  })
})

describe('error handling', () => {
  it('formats OpenAI API error with code and message', () => {
    const status = 400
    const body = JSON.stringify({
      error: { code: 'invalid_api_key', message: 'Incorrect API key provided' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (invalid_api_key): Incorrect API key provided',
    )
  })

  it('formats error with type when code is missing', () => {
    const status = 429
    const body = JSON.stringify({
      error: { type: 'rate_limit_error', message: 'Rate limit exceeded' },
    })
    assert.equal(
      parseOpenAIError(status, body),
      'OpenAI API error (rate_limit_error): Rate limit exceeded',
    )
  })

  it('falls back to HTTP status when error body is unparseable', () => {
    assert.equal(
      parseOpenAIError(500, 'Internal Server Error'),
      'OpenAI API error (HTTP 500): Internal Server Error',
    )
  })
})

describe('retry-after parsing (parseRetryAfterMs)', () => {
  it('parseRetryAfterMs is imported from error-classifier, not a private local', async () => {
    const mod = await import('../openai-client.js')
    assert.ok(mod.OpenAIClient, 'OpenAIClient loads successfully with shared parseRetryAfterMs')
    // parseRetryAfterMs was removed from this module in 119dd49
    assert.equal(typeof (mod as Record<string, unknown>).parseRetryAfterMs, 'undefined',
      'parseRetryAfterMs must not exist on openai-client exports — it lives in error-classifier')
  })

  it('HTTP-date via Date.parse works for future timestamp', () => {
    const futureDate = new Date(Date.now() + 30_000).toUTCString()
    const parsed = Date.parse(futureDate)
    assert.ok(Number.isFinite(parsed), 'Date.parse handles HTTP-date format')
    const delta = parsed - Date.now()
    assert.ok(delta > 0 && delta < 60_000, 'delta from now should be ~30s')
  })
})

describe('DeepSeek-specific features', () => {
  it('1: calls onThinkingDelta for reasoning_content delta', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const thoughts: string[] = []

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Let me think about this...' } }] },
      { onThinkingDelta: (t: string) => thoughts.push(t) },
    )

    assert.equal(thoughts.join(''), 'Let me think about this...')
  })

  it('5: extracts DeepSeek cache stats from usage chunk', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 } },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 60)
    assert.equal(stopUsage.cache_creation_input_tokens, 40)
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('5a: extracts DeepSeek cache stats from COMBINED chunk (finish_reason + usage in one frame)', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    // Single combined chunk: finish_reason AND usage in the same SSE frame.
    // This is the DeepSeek behavior — unlike OpenAI which sends usage as a
    // separate trailing chunk.
    client.processDelta(
      {
        choices: [{ delta: { content: 'final text' }, finish_reason: 'stop' }],
        usage: { prompt_tokens: 100, completion_tokens: 20, prompt_cache_hit_tokens: 60, prompt_cache_miss_tokens: 40 },
      },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
    assert.equal(stopUsage.cache_read_input_tokens, 60)
    assert.equal(stopUsage.cache_creation_input_tokens, 40)
    assert.equal(stopUsage.input_tokens, 100)
    assert.equal(stopUsage.output_tokens, 20)
  })

  it('6: maps insufficient_system_resource finish_reason to end_turn', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    let stopReason: string | undefined
    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'insufficient_system_resource' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 10, completion_tokens: 5 } },
      callbacks,
    )

    assert.equal(stopReason, 'end_turn')
  })

  it('7: thinking-only turn — onThinkingDelta called, onTextDelta not called', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const thoughts: string[] = []
    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: (t: string) => texts.push(t),
      onThinkingDelta: (t: string) => thoughts.push(t),
      onContentBlock: () => {},
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Step 1: analyze' }, finish_reason: null }] },
      callbacks,
    )
    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Step 2: conclude' }, finish_reason: null }] },
      callbacks,
    )

    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    client.processDelta(
      { usage: { prompt_tokens: 50, completion_tokens: 0 } },
      callbacks,
    )

    assert.equal(texts.length, 0, 'onTextDelta should not be called for thinking-only')
    assert.equal(thoughts.length, 2, 'onThinkingDelta should be called for each reasoning_content delta')
    assert.equal(thoughts.join(''), 'Step 1: analyzeStep 2: conclude')
    assert.equal(stopReason, 'end_turn')
  })
})
