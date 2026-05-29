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

  // ── Range-aware dedup tests ──

  it('does NOT remove read_file with non-overlapping offset ranges', () => {
    // read_file("app.tsx", offset=1, limit=100) — reads lines 1-100
    // read_file("app.tsx", offset=200, limit=100) — reads lines 200-300
    // These ranges do not overlap → first result should be preserved
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/app.tsx', offset: '1', limit: '100' })] },
      { role: 'tool', content: 'lines 1-100\n'.repeat(50), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/app.tsx', offset: '200', limit: '100' })] },
      { role: 'tool', content: 'lines 200-300\n'.repeat(50), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 0, 'non-overlapping ranges should NOT be redundant')
    // First read result preserved
    assert.ok(!result.messages[3]!.content.startsWith('[diet:'), `expected preserved content, got: ${result.messages[3]!.content.slice(0, 50)}`)
  })

  it('removes ranged read when later full read contains it', () => {
    // read_file("app.tsx", offset=100, limit=50) — reads lines 100-149
    // read_file("app.tsx") — full read contains everything
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/app.tsx', offset: '100', limit: '50' })] },
      { role: 'tool', content: 'lines 100-149\n'.repeat(30), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/app.tsx' })] },
      { role: 'tool', content: 'full file\n'.repeat(200), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 1, 'full read should contain ranged read')
    assert.ok(result.messages[3]!.content.startsWith('[diet:redundant]'))
    assert.ok(!result.messages[6]!.content.startsWith('[diet:'))
  })

  it('removes smaller range when larger range read later contains it', () => {
    // read_file("app.tsx", offset=120, limit=30) — reads lines 120-149
    // read_file("app.tsx", offset=100, limit=200) — reads lines 100-299 (contains 120-149)
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/app.tsx', offset: '120', limit: '30' })] },
      { role: 'tool', content: 'lines 120-149\n'.repeat(20), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/app.tsx', offset: '100', limit: '200' })] },
      { role: 'tool', content: 'lines 100-299\n'.repeat(100), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 1, 'larger range should contain smaller range')
    assert.ok(result.messages[3]!.content.startsWith('[diet:redundant]'))
  })

  it('does NOT remove full read when later ranged read does NOT contain it', () => {
    // read_file("app.tsx") — full read
    // read_file("app.tsx", offset=500, limit=100) — only reads 500-599
    // The ranged read does NOT contain the full read → full read should be preserved
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/app.tsx' })] },
      { role: 'tool', content: 'full file\n'.repeat(300), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/app.tsx', offset: '500', limit: '100' })] },
      { role: 'tool', content: 'lines 500-599\n'.repeat(50), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 0, 'ranged read should NOT contain full read')
    assert.ok(!result.messages[3]!.content.startsWith('[diet:'), `expected preserved content, got: ${result.messages[3]!.content.slice(0, 50)}`)
  })

  it('removes full read when later full read of same file exists (existing behavior)', () => {
    // This is the original test case — full reads should still be deduped
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'const x = 1;\n'.repeat(100), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/foo.ts' })] },
      { role: 'tool', content: 'const x = 1;\n'.repeat(100), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 1)
    assert.ok(result.messages[3]!.content.startsWith('[diet:redundant]'))
    assert.ok(!result.messages[6]!.content.startsWith('[diet:'))
  })

  it('does NOT remove ranged read when later read has offset-only (start differs)', () => {
    // read_file("app.tsx", offset=1, limit=100) — lines 1-100
    // read_file("app.tsx", offset=500) — lines 500-EOF (does not contain 1-100)
    const messages: OaiMessage[] = [
      anchor1, anchor2,
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc1', 'read_file', { file_path: 'src/app.tsx', offset: '1', limit: '100' })] },
      { role: 'tool', content: 'lines 1-100\n'.repeat(50), tool_call_id: 'tc1' },
      { role: 'assistant', content: 'thinking...' },
      { role: 'assistant', content: '', tool_calls: [makeToolCall('tc2', 'read_file', { file_path: 'src/app.tsx', offset: '500' })] },
      { role: 'tool', content: 'lines 500-EOF\n'.repeat(100), tool_call_id: 'tc2' },
      // recent
      { role: 'user', content: 'q1' }, { role: 'assistant', content: 'a1' },
      { role: 'user', content: 'q2' }, { role: 'assistant', content: 'a2' },
      { role: 'user', content: 'q3' }, { role: 'assistant', content: 'a3' },
    ]
    const result = applyAgentDiet(messages)
    assert.equal(result.categories.redundant, 0, 'offset-only from 500 does not contain lines 1-100')
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
