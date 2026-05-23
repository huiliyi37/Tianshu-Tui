import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyAgentDiet } from '../agent-diet.js'
import type { OaiMessage } from '../agent-diet.js'

function makeToolCall(id: string, name: string, args: Record<string, string>) {
  return { id, function: { name, arguments: JSON.stringify(args) } }
}

describe('agent-diet', () => {
  const anchor1: OaiMessage = { role: 'user', content: 'initial request' }
  const anchor2: OaiMessage = { role: 'assistant', content: 'ok' }

  it('removes redundant file reads (same file read twice)', () => {
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'const x = 1;\n'.repeat(100), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'const x = 1;\n'.repeat(100), tool_call_id: 'tc2' },
      // recent messages (protected)
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 1)
    assert.ok(result.messages[3]!.content.startsWith('[diet:redundant]'))
    assert.ok(!result.messages[6]!.content.startsWith('[diet:'))
  })

  it('removes expired reads (file edited after read)', () => {
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/bar.ts' })] },
      { role: 'tool', content: 'old content here\n'.repeat(50), tool_call_id: 'tc1' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'edit_file', { file_path: 'src/bar.ts' })] },
      { role: 'tool', content: 'Edit applied', tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.expired, 1)
    assert.ok(result.messages[3]!.content.startsWith('[diet:expired]'))
  })

  it('removes useless failed-then-retried tool calls', () => {
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/x.ts' })] },
      { role: 'tool', content: 'Error: ENOENT no such file', tool_call_id: 'tc1' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/x.ts' })] },
      { role: 'tool', content: 'actual file content', tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.useless, 1)
    assert.ok(result.messages[3]!.content.startsWith('[diet:useless]'))
  })

  it('protects recent messages', () => {
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'content', tool_call_id: 'tc1' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'content again', tool_call_id: 'tc2' },
    ]
    // All messages within protection window (2 anchor + 4 = 6 total, protectRecent=6 covers all)
    const result = applyAgentDiet(messages)
    assert.equal(result.removedCount, 0)
  })

  it('returns unchanged messages when nothing to reduce', () => {
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
      { role: 'user', content: 'q4' }, { role: 'assistant', content: 'a4' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.removedCount, 0)
    assert.equal(result.messages, messages) // same reference = no copy
  })
})
