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

describe('final text content block emission', () => {
  function sseStream(frames: string[]): ReadableStream<Uint8Array> {
    const encoder = new TextEncoder()
    return new ReadableStream({
      start(controller) {
        for (const f of frames) controller.enqueue(encoder.encode(f))
        controller.close()
      },
    })
  }

  it('emits a text content block at stream end for text-only replies', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"Hello"},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"content":" world"},"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1, 'exactly one text content block must be emitted')
    assert.equal(textBlocks[0].text, 'Hello world')
  })

  it('emits text block alongside tool_use when text precedes tool calls', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"content":"Checking weather. "},"index":0}]}\n\n',
      'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_1","type":"function","function":{"name":"get_weather","arguments":"{}"}}]},"index":0,"finish_reason":"tool_calls"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 1)
    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1)
    assert.equal(textBlocks[0].text, 'Checking weather. ')
  })

  it('does NOT emit text block when content was consumed as tool JSON (hasToolJsonInContentBug)', async () => {
    const client = new OpenAIClient({
      ...TEST_CONFIG,
      capabilities: { hasToolJsonInContentBug: true },
    })
    const toolJson = '{"name":"read_file","arguments":{"file_path":"/tmp/x"}}'
    const response = new Response(sseStream([
      `data: {"choices":[{"delta":{"content":${JSON.stringify(toolJson)}},"index":0,"finish_reason":"stop"}]}\n\n`,
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'tool_use').length, 1, 'tool JSON must be parsed into tool_use')
    assert.equal(blocks.filter(b => b.type === 'text').length, 0, 'tool JSON must not also persist as text')
  })

  it('emits text block from promoted reasoning for GLM thinking-only replies', async () => {
    const client = new OpenAIClient({ ...TEST_CONFIG, providerName: 'glm' })
    const response = new Response(sseStream([
      'data: {"choices":[{"delta":{"reasoning_content":"The answer is 4."},"index":0,"finish_reason":"stop"}]}\n\n',
      'data: [DONE]\n\n',
    ]))

    const blocks: any[] = []
    const texts: string[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      {
        onTextDelta: (t: string) => texts.push(t),
        onContentBlock: (b: any) => blocks.push(b),
      },
    )

    assert.equal(texts.join(''), 'The answer is 4.', 'reasoning promoted to visible text')
    const textBlocks = blocks.filter(b => b.type === 'text')
    assert.equal(textBlocks.length, 1, 'promoted text must persist as a text block')
    assert.equal(textBlocks[0].text, 'The answer is 4.')
  })

  it('does not emit a text block when no content arrived', async () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const response = new Response(sseStream(['data: [DONE]\n\n']))

    const blocks: any[] = []
    await (client as any).parseStreamFromReader(
      response.body!.getReader(),
      { onTextDelta: () => {}, onContentBlock: (b: any) => blocks.push(b) },
    )

    assert.equal(blocks.filter(b => b.type === 'text').length, 0)
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

  it('8: thinking plus tool call is actionable and not text-only', () => {
    const client = new OpenAIClient(TEST_CONFIG)

    const texts: string[] = []
    const thoughts: string[] = []
    const blocks: any[] = []
    let stopReason: string | undefined

    const callbacks = {
      onTextDelta: (t: string) => texts.push(t),
      onThinkingDelta: (t: string) => thoughts.push(t),
      onContentBlock: (block: any) => blocks.push(block),
      onStopReason: (reason: string) => { stopReason = reason },
    }

    client.processDelta(
      { choices: [{ delta: { reasoning_content: 'Need to submit the plan.' }, finish_reason: null }] },
      callbacks,
    )
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_plan', type: 'function', function: { name: 'plan_submit', arguments: '{"title":"Stepwise Document Writing","plan":"Do it."}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )
    client.processDelta(
      { usage: { prompt_tokens: 100, completion_tokens: 20 } },
      callbacks,
    )

    assert.deepEqual(texts, [])
    assert.deepEqual(thoughts, ['Need to submit the plan.'])
    assert.equal(blocks.length, 1)
    assert.equal(blocks[0].name, 'plan_submit')
    assert.equal(stopReason, 'tool_use')
  })
})

describe('usage calibration (GLM prompt_tokens inflation)', () => {
  // Helper: create client with given calibration factor and pre-set messages
  function makeClient(factor: number | undefined, messages?: object[]): OpenAIClient {
    const client = new OpenAIClient({
      ...TEST_CONFIG,
      usageCalibrationFactor: factor,
      providerName: factor === 0 ? 'glm' : undefined,
    })
    // processDelta reads this.lastRequestMessages for estimation
    ;(client as any).lastRequestMessages = messages ?? []
    return client
  }

  function getUsage(client: OpenAIClient): any {
    let usage: any = null
    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      { onStopReason: (_r: string, u: any) => { usage = u } },
    )
    client.processDelta(
      { usage: { prompt_tokens: 1_970_432, completion_tokens: 500, prompt_cache_hit_tokens: 1_778_816, prompt_cache_miss_tokens: 0 } },
      { onStopReason: (_r: string, u: any) => { usage = u } },
    )
    return usage
  }

  it('GLM factor=0: replaces input_tokens with local estimate', () => {
    // 1000 chars of content → ~250 tokens estimated
    const bigText = 'x'.repeat(1000)
    const client = makeClient(0, [{ role: 'user', content: bigText }])

    const usage = getUsage(client)

    // Should NOT be 1,970,432 (the inflated GLM value)
    assert.ok(usage.input_tokens < 1_000_000,
      `input_tokens should be estimated, not 1.97M (got ${usage.input_tokens})`)
    assert.equal(usage.input_tokens, 250, '1000 chars / 4 = 250 tokens')
  })

  it('default (no factor): trusts API prompt_tokens as-is', () => {
    const client = makeClient(undefined, [{ role: 'user', content: 'hi' }])

    const usage = getUsage(client)

    assert.equal(usage.input_tokens, 1_970_432,
      'without calibration, API value should pass through')
  })

  it('factor=1: trusts API prompt_tokens as-is', () => {
    const client = makeClient(1, [{ role: 'user', content: 'hi' }])

    const usage = getUsage(client)

    assert.equal(usage.input_tokens, 1_970_432)
  })

  it('GLM factor=0: scales cache_read proportionally', () => {
    const bigText = 'x'.repeat(1000)
    const client = makeClient(0, [{ role: 'user', content: bigText }])

    const usage = getUsage(client)

    // apiRatio = 250 / 1_970_432 ≈ 0.000127
    // cache_read = round(1_778_816 * 0.000127) ≈ 226
    assert.ok(usage.cache_read_input_tokens < usage.input_tokens,
      'cache_read should be scaled down proportionally')
    assert.ok(usage.cache_read_input_tokens > 0,
      'cache_read should be non-zero after proportional scaling')
  })
})
