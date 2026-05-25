import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { SessionContext } from '../context.js'
import { INLINE_TOOL_RESULT_MAX_CHARS } from '../../compact/constants.js'

describe('SessionContext tool result memory trimming', () => {
  it('truncates tool result content exceeding INLINE_TOOL_RESULT_MAX_CHARS in addToolResults', () => {
    const session = new SessionContext()
    const longContent = 'x'.repeat(INLINE_TOOL_RESULT_MAX_CHARS + 100)

    session.addUserMessage('test')
    session.addAssistantBlocks([
      { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: '/test.txt' } },
    ])
    session.addToolResults([
      { type: 'tool_result', tool_use_id: 't1', content: longContent },
    ])

    const messages = session.getMessages()
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg, 'tool message should exist')

    // Content should be truncated, with memory-trimmed marker
    assert.ok(
      toolMsg.content.length <= INLINE_TOOL_RESULT_MAX_CHARS + '<memory-trimmed />'.length + 80,
      `tool result content should be trimmed to ~${INLINE_TOOL_RESULT_MAX_CHARS}, got ${toolMsg.content.length}`
    )
    assert.ok(
      toolMsg.content.includes('<memory-trimmed'),
      'should include memory-trimmed marker'
    )
  })

  it('preserves artifact marker when truncating', () => {
    const session = new SessionContext()
    const longContent = 'x'.repeat(INLINE_TOOL_RESULT_MAX_CHARS + 100) + '\n[artifact:test-123]'

    session.addUserMessage('test')
    session.addAssistantBlocks([
      { type: 'tool_use', id: 't1', name: 'read_file', input: { file_path: '/test.txt' } },
    ])
    session.addToolResults([
      { type: 'tool_result', tool_use_id: 't1', content: longContent },
    ])

    const messages = session.getMessages()
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg, 'tool message should exist')
    assert.ok(
      toolMsg.content.includes('[artifact:test-123]'),
      'artifact marker should be preserved after truncation'
    )
  })

  it('does not truncate short tool results', () => {
    const session = new SessionContext()
    const shortContent = 'short output'

    session.addUserMessage('test')
    session.addAssistantBlocks([
      { type: 'tool_use', id: 't1', name: 'bash', input: { command: 'echo hi' } },
    ])
    session.addToolResults([
      { type: 'tool_result', tool_use_id: 't1', content: shortContent },
    ])

    const messages = session.getMessages()
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg, 'tool message should exist')
    assert.equal(toolMsg.content, shortContent, 'short content should be unchanged')
  })

  it('handles tool results with no artifact marker', () => {
    const session = new SessionContext()
    const longContent = 'A'.repeat(INLINE_TOOL_RESULT_MAX_CHARS + 500)

    session.addUserMessage('test')
    session.addAssistantBlocks([
      { type: 'tool_use', id: 't1', name: 'grep', input: { pattern: 'test' } },
    ])
    session.addToolResults([
      { type: 'tool_result', tool_use_id: 't1', content: longContent },
    ])

    const messages = session.getMessages()
    const toolMsg = messages.find(m => m.role === 'tool')
    assert.ok(toolMsg, 'tool message should exist')
    // Should still truncate with just the marker
    assert.ok(
      toolMsg.content.includes('<memory-trimmed'),
      'should include memory-trimmed marker even without artifact'
    )
  })
})
