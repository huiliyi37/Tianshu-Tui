import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CodexClient } from '../codex-client.js'

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
      messages: [{ role: 'user', content: 'hello' }],
      max_tokens: 64000,
      system: 'You are a helpful assistant.',
      stream: true,
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
          content: [
            { type: 'tool_use', id: 'call_123', name: 'bash', input: { command: 'ls' } },
          ],
        },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: 'call_123', content: 'file.txt' },
          ],
        },
      ],
      max_tokens: 64000,
      stream: true,
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
})
