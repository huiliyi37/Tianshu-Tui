import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { AnthropicClient } from '../anthropic-client.js'

function makeClient() {
  return new AnthropicClient({
    baseUrl: 'https://api.anthropic.com',
    apiKey: 'test-key',
    model: 'claude-opus-4-7',
    maxTokens: 4096,
  })
}

describe('AnthropicClient message conversion', () => {
  it('extracts system message to top-level system array', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are a helpful assistant.' },
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 4096,
    })
    assert.ok(Array.isArray(body.system))
    const sys = body.system!
    assert.equal(sys.length, 1)
    const sys0 = sys[0]!
    assert.equal(sys0.type, 'text')
    assert.equal(sys0.text, 'You are a helpful assistant.')
    const hasSystemInMessages = (body.messages as Array<{ role: string }>).some(m => m.role === 'system')
    assert.equal(hasSystemInMessages, false)
  })

  it('converts user message to content blocks array', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Hello world' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.messages.length, 1)
    const msg = body.messages[0]!
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'text')
    assert.equal(block.text, 'Hello world')
  })

  it('converts assistant message with text to content blocks', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'Hi there!' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'text')
    assert.equal(block.text, 'Hi there!')
  })

  it('converts assistant with tool_calls to tool_use blocks', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: 'Let me read that file.',
          tool_calls: [
            { id: 'call_1', type: 'function', function: { name: 'read_file', arguments: '{"file_path":"/foo"}' } },
          ],
        },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    const types = msg.content.map(b => b.type)
    assert.ok(types.includes('text'))
    assert.ok(types.includes('tool_use'))
    const toolUse = msg.content.find(b => b.type === 'tool_use')
    assert.ok(toolUse)
    assert.equal(toolUse.name, 'read_file')
    assert.deepEqual(toolUse.input, { file_path: '/foo' })
  })

  it('converts tool result message to tool_result content block in user role', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'tool', tool_call_id: 'call_1', content: 'file contents here' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'user')
    assert.ok(Array.isArray(msg.content))
    const block = msg.content[0]!
    assert.equal(block.type, 'tool_result')
    assert.equal(block.tool_use_id, 'call_1')
    assert.equal(block.content, 'file contents here')
  })

  it('converts tools to Anthropic input_schema format sorted by name', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'zebra', description: 'z', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'alpha', description: 'a', parameters: { type: 'object', properties: { x: { type: 'string' } }, required: ['x'] } } },
      ],
    })
    assert.ok(Array.isArray(body.tools))
    const tools = body.tools!
    assert.equal(tools.length, 2)
    assert.equal(tools[0]!.name, 'alpha')
    assert.equal(tools[1]!.name, 'zebra')
    assert.equal(tools[0]!.input_schema.type, 'object')
    assert.deepEqual(tools[0]!.input_schema.required, ['x'])
  })

  it('handles assistant message with reasoning_content', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'assistant', content: 'answer', reasoning_content: 'thinking...' },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    const types = msg.content.map(b => b.type)
    assert.ok(types.includes('thinking'))
    assert.ok(types.includes('text'))
    const thinkingBlock = msg.content.find(b => b.type === 'thinking')
    assert.ok(thinkingBlock)
    assert.equal(thinkingBlock.thinking, 'thinking...')
  })

  it('handles no system message gracefully', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'Hello' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.system, undefined)
  })

  it('handles assistant with null content (tool-only response)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        {
          role: 'assistant',
          content: null,
          tool_calls: [
            { id: 'call_2', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } },
          ],
        },
      ],
      max_tokens: 4096,
    })
    const msg = body.messages[0]!
    assert.equal(msg.role, 'assistant')
    const types = msg.content.map(b => b.type)
    assert.ok(!types.includes('text'))
    assert.ok(types.includes('tool_use'))
  })

  it('sets required Anthropic body fields', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [{ role: 'user', content: 'test' }],
      max_tokens: 4096,
    })
    assert.equal(body.model, 'claude-opus-4-7')
    assert.equal(body.max_tokens, 4096)
    assert.equal(body.stream, true)
    assert.ok(Array.isArray(body.messages))
    assert.equal(body.messages.length, 1)
  })
})

describe('cache_control breakpoint injection', () => {
  it('injects BP1 on last tool definition (1h TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
      tools: [
        { type: 'function', function: { name: 'tool_a', description: '', parameters: { type: 'object', properties: {} } } },
        { type: 'function', function: { name: 'tool_b', description: '', parameters: { type: 'object', properties: {} } } },
      ],
    })
    const tools = body.tools!
    assert.equal(tools.length, 2)
    const lastTool = tools[tools.length - 1]!
    assert.deepEqual(lastTool.cache_control, { type: 'ephemeral' })
    assert.equal(tools[0]!.cache_control, undefined)
  })

  it('injects BP2 on last system content block (1h TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'You are helpful.' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
    })
    const sys = body.system!
    const lastSystemBlock = sys[sys.length - 1]!
    assert.deepEqual(lastSystemBlock.cache_control, { type: 'ephemeral' })
  })

  it('injects BP3 on first user message last content block (5m TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'project instructions + memory + first message' },
        { role: 'assistant', content: 'response' },
        { role: 'user', content: 'second message' },
      ],
      max_tokens: 4096,
    })
    const firstUserMsg = body.messages[0]!
    assert.equal(firstUserMsg.role, 'user')
    const blocks = firstUserMsg.content
    const lastBlock = blocks[blocks.length - 1]!
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' })
  })

  it('injects BP4 on last completed assistant turn before final user (5m TTL)', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'first message' },
        { role: 'assistant', content: 'first response' },
        { role: 'user', content: 'second message' },
        { role: 'assistant', content: 'second response' },
        { role: 'user', content: 'third message' },
      ],
      max_tokens: 4096,
    })
    // messages: [user("first msg"), assistant("first"), user("second"), assistant("second"), user("third")]
    // BP4 on assistant("second response") — index 3
    const bp4Msg = body.messages[3]!
    assert.equal(bp4Msg.role, 'assistant')
    const blocks = bp4Msg.content
    const lastBlock = blocks[blocks.length - 1]!
    assert.deepEqual(lastBlock.cache_control, { type: 'ephemeral' })
  })

  it('handles single turn — BP3 on only user, no BP4', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'only message' },
      ],
      max_tokens: 4096,
    })
    // BP3 on first (only) user message
    const msg = body.messages[0]!
    assert.deepEqual(msg.content[0]!.cache_control, { type: 'ephemeral' })
    // No assistant before final user → no BP4
  })

  it('handles no tools — no BP1, but BP2+BP3 still injected', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'test' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.tools, undefined)
    // BP2 still present
    const sys = body.system!
    assert.deepEqual(sys[sys.length - 1]!.cache_control, { type: 'ephemeral' })
    // BP3 still present
    assert.deepEqual(body.messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
  })

  it('handles no system — BP2 skipped, other breakpoints still present', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'only user message' },
      ],
      max_tokens: 4096,
    })
    assert.equal(body.system, undefined)
    // BP3 still present on first user
    assert.deepEqual(body.messages[0]!.content[0]!.cache_control, { type: 'ephemeral' })
  })

  it('does not duplicate cache_control on blocks that already have it from BP3', () => {
    const client = makeClient()
    const body = client.buildRequestBodyForTest({
      model: 'claude-opus-4-7',
      messages: [
        { role: 'user', content: 'single user' },
        { role: 'assistant', content: 'single assistant' },
        { role: 'user', content: 'final user' },
      ],
      max_tokens: 4096,
    })
    // BP3 on first user (index 0), BP4 on assistant (index 1)
    // Each should have exactly one cache_control
    const bp3Msg = body.messages[0]!
    const bp3Block = bp3Msg.content[bp3Msg.content.length - 1]!
    assert.deepEqual(bp3Block.cache_control, { type: 'ephemeral' })

    const bp4Msg = body.messages[1]!
    assert.equal(bp4Msg.role, 'assistant')
    const bp4Block = bp4Msg.content[bp4Msg.content.length - 1]!
    assert.deepEqual(bp4Block.cache_control, { type: 'ephemeral' })
  })
})
