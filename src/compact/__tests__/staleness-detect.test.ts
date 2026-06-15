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

  // ── Range-aware superseded tests ──

  it('does NOT supersede read_file with non-overlapping offset ranges', () => {
    // read_file("app.tsx", offset=1, limit=100) → later read_file("app.tsx", offset=200, limit=100)
    // Non-overlapping → first read should NOT be superseded
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":1,"limit":100}' }]),
      tool('tc1', longContent),
      assistantText('thinking about top of file'),
      assistantText('more thinking'),
      assistantText('even more'),
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":200,"limit":100}' }]),
      tool('tc2', longContent + 'different'),
      assistantText('looking at different section'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 0, 'non-overlapping ranges should NOT be superseded')
    const firstRead = result.messages[3]!
    assert.ok(!(firstRead.content as string).includes('superseded'), `expected preserved, got: ${(firstRead.content as string).slice(0, 80)}`)
  })

  it('supersedes ranged read when later full read contains it', () => {
    // read_file("app.tsx", offset=100, limit=50) → later read_file("app.tsx") full
    // Full read contains the range → should be superseded
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":100,"limit":50}' }]),
      tool('tc1', longContent),
      assistantText('thinking'),
      assistantText('more thinking'),
      assistantText('even more'),
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/app.tsx"}' }]),
      tool('tc2', longContent + 'full'),
      assistantText('full read done'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 1, 'full read should contain ranged read')
    const firstRead = result.messages[3]!
    assert.ok((firstRead.content as string).includes('superseded'))
  })

  it('does NOT supersede full read when later ranged read is partial', () => {
    // read_file("app.tsx") full → later read_file("app.tsx", offset=500, limit=100)
    // Partial read does NOT contain full read → should NOT be superseded
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/app.tsx"}' }]),
      tool('tc1', longContent),
      assistantText('thinking about full file'),
      assistantText('more thinking'),
      assistantText('even more'),
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":500,"limit":100}' }]),
      tool('tc2', longContent + 'partial'),
      assistantText('looking at specific section'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 0, 'partial read should NOT supersede full read')
  })

  it('supersedes read_file when later read has larger containing range', () => {
    // read_file(offset=120, limit=30) → later read_file(offset=100, limit=200)
    // Larger range contains smaller → should be superseded
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
      assistant([{ id: 'tc1', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":120,"limit":30}' }]),
      tool('tc1', longContent),
      assistantText('thinking'),
      assistantText('more thinking'),
      assistantText('even more'),
      assistant([{ id: 'tc2', name: 'read_file', args: '{"file_path":"src/app.tsx","offset":100,"limit":200}' }]),
      tool('tc2', longContent + 'larger'),
      assistantText('larger range done'),
    ]
    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 1, 'larger range should contain smaller range')
    assert.ok((result.messages[3]!.content as string).includes('superseded'))
  })

  it('handles many file reads without excessive parse overhead', () => {
    // 20 file reads of different files — should all be handled correctly
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hi' },
    ]
    for (let i = 0; i < 20; i++) {
      messages.push(assistant([{ id: `tc${i}`, name: 'read_file', args: `{"file_path":"src/file${i}.ts"}` }]))
      messages.push(tool(`tc${i}`, `content of file${i} `.repeat(30)))
      messages.push(assistantText(`thinking about file${i}`))
    }
    // Read file0.ts again at the end — should supersede the first read
    messages.push(assistant([{ id: 'tc_sup', name: 'read_file', args: '{"file_path":"src/file0.ts"}' }]))
    messages.push(tool('tc_sup', 'updated content of file0 '.repeat(30)))
    messages.push(assistantText('done'))

    const result = detectStaleness(messages, 2)
    assert.equal(result.supersededCount, 1, 'first read_file of file0 should be superseded by later read')
  })
})
