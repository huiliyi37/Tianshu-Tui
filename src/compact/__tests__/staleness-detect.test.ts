import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { detectStaleness } from '../staleness-detect.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('detectStaleness', () => {
  function tool(id: string, content: string): OaiMessage {
    return { role: 'tool', tool_call_id: id, content }
  }
  function assistant(toolCalls: { id: string; name: string; args: string }[], content?: string): OaiMessage {
    return {
      role: 'assistant',
      content: content ?? null,
      tool_calls: toolCalls.map(tc => ({ id: tc.id, type: 'function' as const, function: { name: tc.name, arguments: tc.args } })),
    }
  }
  function assistantText(content: string): OaiMessage {
    return { role: 'assistant', content }
  }

  const longContent = 'x'.repeat(600)

  it('detects superseded file reads', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      // First read of foo.ts
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/foo.ts"}' }]),
      tool('tc1', longContent),
      // 3 assistant turns after (to satisfy lag)
      assistantText('thinking about foo'),
      assistantText('more thinking'),
      assistantText('even more'),
      // Second read of same file
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/foo.ts"}' }]),
      tool('tc2', longContent + ' updated'),
      assistantText('now using updated foo'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 1)
    assert.ok(result.freedChars > 0)
    const oldTool = result.messages[3]!
    assert.ok(oldTool.role === 'tool')
    assert.ok(oldTool.content.includes('superseded'))
    // New read should be untouched
    const newTool = result.messages[8]!
    assert.ok(newTool.role === 'tool')
    assert.ok(!newTool.content.includes('superseded'))
  })

  it('detects unreferenced tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'list_dir', args: '{"path":"src/utils"}' }]),
      tool('tc1', 'totally unique content that nobody ever mentions again '.repeat(15)),
      // 3+ assistant turns that don't reference the content
      assistantText('I will now work on something else entirely'),
      assistantText('continuing with unrelated work here'),
      assistantText('still doing other things'),
      assistantText('final unrelated thought'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.unreferencedCount, 1)
    const toolMsg = result.messages[3]!
    assert.ok(toolMsg.role === 'tool')
    assert.ok(toolMsg.content.includes('unreferenced'))
  })

  it('preserves recent tool results within lag window', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/bar.ts"}' }]),
      tool('tc1', longContent),
      // Only 1 assistant turn after — within lag window
      assistantText('just read bar'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 0)
    assert.equal(result.unreferencedCount, 0)
  })

  it('respects anchor boundary', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/foo.ts"}' }]),
      tool('tc1', longContent),
    ]
    const result = detectStaleness(messages, 3)
    assert.equal(result.supersededCount, 0)
    assert.equal(result.unreferencedCount, 0)
  })

  it('skips short tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/foo.ts"}' }]),
      tool('tc1', 'short'),
      assistantText('a'), assistantText('b'), assistantText('c'),
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/foo.ts"}' }]),
      tool('tc2', 'short too'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 0)
  })
})
