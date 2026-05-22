import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { isAssistantWithTools, isToolMessage, isUserMessage, type OaiChatRequest, type OaiMessage } from '../oai-types.js'

describe('OpenAI-native API types', () => {
  it('narrows tool messages with tool_call_id', () => {
    const msg: OaiMessage = {
      role: 'tool',
      tool_call_id: 'call_123',
      content: 'done',
    }

    assert.equal(isToolMessage(msg), true)
    if (isToolMessage(msg)) {
      assert.equal(msg.tool_call_id, 'call_123')
    }
  })

  it('narrows assistant messages with tool calls', () => {
    const msg: OaiMessage = {
      role: 'assistant',
      content: null,
      reasoning_content: 'Need to inspect the file.',
      tool_calls: [
        {
          id: 'call_read',
          type: 'function',
          function: {
            name: 'read_file',
            arguments: '{"file_path":"src/main.tsx"}',
          },
        },
      ],
    }

    assert.equal(isAssistantWithTools(msg), true)
    if (isAssistantWithTools(msg)) {
      assert.equal(msg.tool_calls[0]?.function.name, 'read_file')
      assert.equal(msg.reasoning_content, 'Need to inspect the file.')
    }
  })

  it('does not classify empty tool_calls as assistant-with-tools', () => {
    const msg: OaiMessage = {
      role: 'assistant',
      content: 'No tools needed.',
      tool_calls: [],
    }

    assert.equal(isAssistantWithTools(msg), false)
  })

  it('narrows user messages', () => {
    const msg: OaiMessage = {
      role: 'user',
      content: 'Continue.',
    }

    assert.equal(isUserMessage(msg), true)
    assert.equal(isToolMessage(msg), false)
  })

  it('supports OpenAI-compatible request bodies with cache usage fields', () => {
    const request: OaiChatRequest = {
      model: 'deepseek-chat',
      messages: [
        { role: 'system', content: 'You are concise.' },
        { role: 'user', content: 'Read the file.' },
      ],
      tools: [
        {
          type: 'function',
          function: {
            name: 'read_file',
            description: 'Read a file',
            parameters: {
              type: 'object',
              properties: { file_path: { type: 'string' } },
              required: ['file_path'],
            },
          },
        },
      ],
      tool_choice: 'auto',
      max_tokens: 1024,
      stream: true,
      reasoning_effort: 'low',
    }

    assert.equal(request.messages.length, 2)
    assert.equal(request.tools?.[0]?.function.name, 'read_file')
  })
})
