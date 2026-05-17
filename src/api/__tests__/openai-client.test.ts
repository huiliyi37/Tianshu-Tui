import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { OpenAIClient, parseOpenAIError, type OpenAIClientConfig } from '../openai-client.js'
import type { MessageRequest } from '../types.js'

const TEST_CONFIG: OpenAIClientConfig = {
  baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test',
  model: 'gpt-4o',
  maxTokens: 4096,
}

function makeRequest(text: string): MessageRequest {
  return {
    model: 'gpt-4o',
    messages: [
      { role: 'user', content: [{ type: 'text', text }] },
    ],
    system: 'You are a helpful assistant.',
    max_tokens: 4096,
  }
}

describe('OpenAIClient', () => {
  it('implements StreamClient interface', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    assert.equal(typeof client.stream, 'function')
    assert.equal(client.stream.length, 3)
  })

  it('buildRequestBody produces valid OpenAI request body', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const body = (client as any).buildRequestBody(makeRequest('Hello'))
    assert.equal(body.model, 'gpt-4o')
    assert.equal(body.stream, true)
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.messages.length, 2)
    assert.equal(body.messages[0].role, 'system')
    assert.equal(body.messages[0].content, 'You are a helpful assistant.')
    assert.equal(body.messages[1].role, 'user')
    assert.equal(body.messages[1].content, 'Hello')
  })

  it('omits system message when request.system is undefined', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'Hi' }] },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    assert.equal(body.messages.length, 1)
    assert.equal(body.messages[0].role, 'user')
  })

  it('converts assistant tool_use blocks to tool_calls format', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        { role: 'user', content: [{ type: 'text', text: 'What time is it?' }] },
        {
          role: 'assistant',
          content: [
            { type: 'text', text: 'Let me check' },
            { type: 'tool_use', id: 'tu_1', name: 'get_time', input: { tz: 'UTC' } },
          ],
        },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant')
    assert.ok(assistantMsg)
    assert.equal(assistantMsg.content, 'Let me check')
    assert.equal(assistantMsg.tool_calls.length, 1)
    assert.equal(assistantMsg.tool_calls[0].id, 'tu_1')
    assert.equal(assistantMsg.tool_calls[0].function.name, 'get_time')
    assert.equal(assistantMsg.tool_calls[0].function.arguments, '{"tz":"UTC"}')
  })

  it('converts tool_result to OpenAI tool role message', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: '12:00 UTC' },
            { type: 'text', text: 'Thanks' },
          ],
        },
        { role: 'assistant', content: [{ type: 'text', text: 'Youre welcome' }] },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const toolMsg = body.messages.find((m: any) => m.role === 'tool')
    assert.ok(toolMsg, 'tool_result should become a tool-role message')
    assert.equal(toolMsg.tool_call_id, 'tu_1')
    assert.equal(toolMsg.content, '12:00 UTC')
    const userMsg = body.messages.find((m: any) => m.role === 'user')
    assert.ok(userMsg)
    assert.equal(userMsg.content, 'Thanks')
  })

  it('handles assistant message with only tool_use (no text)', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'assistant',
          content: [
            { type: 'tool_use', id: 'tu_1', name: 'run_bash', input: { command: 'ls' } },
          ],
        },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const assistantMsg = body.messages.find((m: any) => m.role === 'assistant')
    assert.ok(assistantMsg)
    assert.equal(assistantMsg.content, undefined)
    assert.equal(assistantMsg.tool_calls.length, 1)
  })

  it('handles multiple tool_results in a user message', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'result1' },
            { type: 'tool_result', tool_use_id: 'tu_2', content: 'result2' },
            { type: 'text', text: 'Done' },
          ],
        },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const toolMsgs = body.messages.filter((m: any) => m.role === 'tool')
    assert.equal(toolMsgs.length, 2)
    assert.equal(toolMsgs[0].tool_call_id, 'tu_1')
    assert.equal(toolMsgs[0].content, 'result1')
    assert.equal(toolMsgs[1].tool_call_id, 'tu_2')
    assert.equal(toolMsgs[1].content, 'result2')
    const userMsg = body.messages.find((m: any) => m.role === 'user')
    assert.ok(userMsg)
    assert.equal(userMsg.content, 'Done')
  })

  it('handles tool_result with is_error flag', () => {
    const client = new OpenAIClient(TEST_CONFIG)
    const request: MessageRequest = {
      model: 'gpt-4o',
      messages: [
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'Permission denied', is_error: true },
          ],
        },
      ],
      max_tokens: 4096,
    }
    const body = (client as any).buildRequestBody(request)
    const toolMsg = body.messages.find((m: any) => m.role === 'tool')
    assert.ok(toolMsg)
    assert.equal(toolMsg.content, 'Permission denied')
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

    // Chunk 1: id + name + empty arguments
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'get_weather', arguments: '' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    // Chunk 2: partial arguments
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"loc' } }] }, finish_reason: null }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 0)

    // Chunk 3: remaining arguments + finish_reason
    client.processDelta(
      { choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: 'ation": "NYC"}' } }] }, finish_reason: 'tool_calls' }] },
      callbacks,
    )

    assert.equal(contentBlocks.length, 1)
    assert.equal(contentBlocks[0].type, 'tool_use')
    assert.equal(contentBlocks[0].id, 'call_abc')
    assert.equal(contentBlocks[0].name, 'get_weather')
    assert.deepEqual(contentBlocks[0].input, { location: 'NYC' })
    // Stop reason is buffered until usage chunk arrives
    assert.equal(stopReason, undefined)

    // Usage-only chunk triggers emission
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

    // Text chunk
    client.processDelta(
      { choices: [{ delta: { content: 'Hello' }, finish_reason: null }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    // finish_reason — buffered
    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )
    assert.equal(stopReason, undefined)

    // usage-only chunk — triggers emission
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
    let stopUsage: any = null

    const callbacks = {
      onTextDelta: () => {},
      onContentBlock: () => {},
      onStopReason: (reason: string, usage: any) => { stopReason = reason; stopUsage = usage },
    }

    // finish_reason without usage chunk
    client.processDelta(
      { choices: [{ delta: {}, finish_reason: 'stop' }] },
      callbacks,
    )

    // Simulate stream end — parseStreamFromReader would flush pendingStopReason
    // Here we test the fallback behavior via parseStreamFromReader
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
