import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CodexClient } from '../codex-client.js'
import { parseRetryAfterMs } from '../error-classifier.js'

describe('CodexClient', () => {
  it('builds request body with instructions and reasoning', async () => {
    // Access private method via prototype
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const body = (client as any).buildRequestBody({
      model: 'gpt-5.5',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'hello' },
      ],
      max_tokens: 64000,
    })

    assert.equal(body.model, 'gpt-5.5')
    assert.equal(body.instructions, 'You are a helpful assistant.')
    assert.deepEqual(body.reasoning, { effort: 'high' })
    assert.equal(body.store, false)
    assert.equal(body.parallel_tool_calls, true)
    assert.deepEqual(body.include, ['reasoning.encrypted_content'])

    // User message should be wrapped in message type
    const input = body.input as any[]
    assert.equal(input.length, 1)
    assert.equal(input[0].type, 'message')
    assert.equal(input[0].role, 'user')
    assert.equal(input[0].content[0].type, 'input_text')
    assert.equal(input[0].content[0].text, 'hello')
  })

  it('converts tool_use to top-level function_call', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const body = (client as any).buildRequestBody({
      model: 'gpt-5.5',
      messages: [
        { role: 'user', content: 'do something' },
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_123', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          ],
        },
        { role: 'tool', tool_call_id: 'call_123', content: 'file.txt' },
      ],
      max_tokens: 64000,
    })

    const input = body.input as any[]
    // user msg, function_call (top-level), function_call_output (top-level)
    assert.equal(input.length, 3)
    assert.equal(input[0].type, 'message')
    assert.equal(input[1].type, 'function_call')
    assert.equal(input[1].call_id, 'call_123')
    assert.equal(input[1].name, 'bash')
    assert.equal(input[2].type, 'function_call_output')
    assert.equal(input[2].call_id, 'call_123')
    assert.equal(input[2].output, 'file.txt')
  })

  it('parses SSE stream with output_text and reasoning events', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const events: string[] = []
    const textDeltas: string[] = []
    const thinkingDeltas: string[] = []

    // Simulate SSE stream
    const sseData = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think..."}',
      'data: {"type":"response.output_text.delta","delta":"Hello!"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Final answer."}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    ].join('\n') + '\n'

    const encoder = new TextEncoder()
    const chunks = encoder.encode(sseData)

    // Create a mock ReadableStream
    let offset = 0
    const mockStream = new ReadableStream({
      pull(controller) {
        if (offset >= chunks.length) {
          controller.close()
          return
        }
        const chunk = chunks.slice(offset, offset + 50)
        offset += 50
        controller.enqueue(chunk)
      },
    })

    const mockResponse = { body: mockStream } as Response

    await (client as any).processSSEStream(mockResponse, {
      onTextDelta: (t: string) => textDeltas.push(t),
      onThinkingDelta: (t: string) => thinkingDeltas.push(t),
      onContentBlock: (b: any) => events.push(`content:${b.type}`),
      onStopReason: (r: string) => events.push(`stop:${r}`),
      onError: (e: Error) => { throw e },
    })

    assert.ok(thinkingDeltas.length > 0, 'Should capture thinking deltas')
    assert.ok(textDeltas.length > 0, 'Should capture text deltas')
    assert.ok(events.includes('stop:stop'), 'Should emit stop reason')
  })

  it('buffers message output_item.done until reasoning arrives — preserves thinking→answer order', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const seq: string[] = []

    // output_item.done (message) arrives BEFORE any reasoning — must be buffered
    const sseData = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Final answer."}],"usage":{"input_tokens":10,"output_tokens":5}}}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Let me think..."}',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":"Step-by-step reasoning."}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":15,"output_tokens":10}}}',
    ].join('\n') + '\n'

    const mockResponse = { body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sseData))
        controller.close()
      },
    }) } as Response

    await (client as any).processSSEStream(mockResponse, {
      onTextDelta: (t: string) => seq.push(`text:${t}`),
      onThinkingDelta: (t: string) => seq.push(`think:${t}`),
      onContentBlock: () => {},
      onStopReason: () => seq.push('stop'),
      onError: (e: Error) => { throw e },
    })

    const thinkIdx = seq.findIndex(s => s.startsWith('think:'))
    const textIdx = seq.findIndex(s => s.startsWith('text:'))

    assert.ok(thinkIdx >= 0, 'Should emit thinking')
    assert.ok(textIdx >= 0, 'Should emit text')
    assert.ok(thinkIdx < textIdx, 'Thinking must appear before text when message done arrives first')
    assert.equal(seq.filter(s => s.startsWith('text:')).join(','), 'text:Final answer.',
      'Should emit buffered message content')
  })

  it('flushes buffered message at stream end when no reasoning events occur', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const textDeltas: string[] = []

    // Only message, no reasoning events at all
    const sseData = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"No reasoning used here."}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":5,"output_tokens":3}}}',
    ].join('\n') + '\n'

    const mockResponse = { body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sseData))
        controller.close()
      },
    }) } as Response

    await (client as any).processSSEStream(mockResponse, {
      onTextDelta: (t: string) => textDeltas.push(t),
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: (e: Error) => { throw e },
    })

    assert.equal(textDeltas.length, 1, 'Should emit text even without reasoning')
    assert.equal(textDeltas[0], 'No reasoning used here.')
  })

  it('emits message immediately when reasoning deltas already arrived', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const seq: string[] = []

    // Reasoning delta arrives BEFORE message output_item.done — no buffering needed
    const sseData = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"Thinking step 1..."}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Here is the answer."}]}}',
      'data: {"type":"response.output_item.done","item":{"type":"reasoning","summary":[{"text":"Complete reasoning."}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    ].join('\n') + '\n'

    const mockResponse = { body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sseData))
        controller.close()
      },
    }) } as Response

    await (client as any).processSSEStream(mockResponse, {
      onTextDelta: (t: string) => seq.push(`text:${t}`),
      onThinkingDelta: (t: string) => seq.push(`think:${t}`),
      onContentBlock: () => {},
      onStopReason: () => seq.push('stop'),
      onError: (e: Error) => { throw e },
    })

    const textIdx = seq.findIndex(s => s.startsWith('text:'))
    assert.ok(textIdx >= 0, 'Should emit text')
    // When reasoning already seen, text should appear before reasoning done event
    assert.ok(seq.some(s => s.startsWith('text:')), 'Text should be emitted')
    assert.equal(seq.filter(s => s.startsWith('text:')).join(','), 'text:Here is the answer.')
  })

  it('does not emit text twice when both delta and output_item.done contain same text', async () => {
    const client = new CodexClient({
      baseUrl: 'https://chatgpt.com/backend-api/codex',
      model: 'gpt-5.5',
      maxTokens: 64000,
    })

    const textDeltas: string[] = []

    // Stream has both output_text.delta events AND output_item.done with message text
    const sseData = [
      'data: {"type":"response.created","response":{"id":"resp_1"}}',
      'data: {"type":"response.reasoning_summary_text.delta","delta":"thinking..."}',
      'data: {"type":"response.output_text.delta","delta":"Hello"}',
      'data: {"type":"response.output_text.delta","delta":" world"}',
      'data: {"type":"response.output_item.done","item":{"type":"message","content":[{"type":"output_text","text":"Hello world"}]}}',
      'data: {"type":"response.completed","response":{"usage":{"input_tokens":10,"output_tokens":5}}}',
    ].join('\n') + '\n'

    const mockResponse = { body: new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(sseData))
        controller.close()
      },
    }) } as Response

    await (client as any).processSSEStream(mockResponse, {
      onTextDelta: (t: string) => textDeltas.push(t),
      onThinkingDelta: () => {},
      onContentBlock: () => {},
      onStopReason: () => {},
      onError: (e: Error) => { throw e },
    })

    // Should only get the delta events, not the duplicate from output_item.done
    assert.deepEqual(textDeltas, ['Hello', ' world'])
  })
})

describe('Retry-After header extraction on 429', () => {
  it('attaches retryAfterMs to error from response Retry-After header', () => {
    const retryAfterValue = '10'
    const retryAfterMs = parseRetryAfterMs(retryAfterValue)
    assert.equal(retryAfterMs, 10_000)
  })
})
