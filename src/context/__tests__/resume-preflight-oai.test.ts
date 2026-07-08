import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import {
  detectOrphanToolCallsOai,
  detectOrphanToolResultsOai,
  runResumePreflightOai,
} from '../resume-preflight.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('detectOrphanToolCallsOai', () => {
  it('returns empty for clean conversation', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'content' },
    ]
    assert.deepStrictEqual(detectOrphanToolCallsOai(messages), [])
  })

  it('detects orphan tool_call with no matching result', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      // No tool result for tc_1
    ]
    assert.deepStrictEqual(detectOrphanToolCallsOai(messages), ['tc_1'])
  })

  it('detects multiple orphans across messages', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'ok' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
        { id: 'tc_3', type: 'function', function: { name: 'bash', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_2', content: 'written' },
      // tc_3 is orphan
    ]
    assert.deepStrictEqual(detectOrphanToolCallsOai(messages), ['tc_3'])
  })
})

describe('detectOrphanToolResultsOai', () => {
  it('returns empty for clean conversation', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'content' },
    ]
    assert.deepStrictEqual(detectOrphanToolResultsOai(messages), [])
  })

  it('detects tool result with no matching tool_call', () => {
    const messages: OaiMessage[] = [
      { role: 'tool', tool_call_id: 'tc_orphan', content: 'orphan' },
    ]
    assert.deepStrictEqual(detectOrphanToolResultsOai(messages), ['tc_orphan'])
  })
})

describe('runResumePreflightOai', () => {
  it('returns safe=true for clean conversation', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.safe, true)
    assert.strictEqual(report.repaired, false)
    assert.strictEqual(report.syntheticResultsInserted, 0)
  })

  it('repairs orphan tool_calls by inserting synthetic results', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'read file' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      // tc_1 has no result — orphan
    ]
    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.repaired, true)
    assert.strictEqual(report.syntheticResultsInserted, 1)
    assert.strictEqual(report.safe, true)
    // Verify the synthetic result was inserted
    const toolResult = report.messages.find(m => m.role === 'tool')
    assert.ok(toolResult)
    assert.strictEqual(toolResult.tool_call_id, 'tc_1')
    assert.ok(toolResult.content.includes('会话中断'))
  })

  it('preserves existing tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      ]},
      // tc_2 is orphan
    ]
    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.repaired, true)
    assert.strictEqual(report.syntheticResultsInserted, 1)
    // tc_1 result should be preserved
    const existingResult = report.messages.find(m => m.role === 'tool' && m.tool_call_id === 'tc_1')
    assert.ok(existingResult)
    assert.strictEqual(existingResult.content, 'file content')
  })

  it('is a no-op (same array reference) for a clean tool round', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'content' },
      { role: 'user', content: 'next' },
    ]
    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.repaired, false)
    assert.strictEqual(report.safe, true)
    assert.strictEqual(report.messages, messages) // identical reference → prefix cache intact
  })

  // Regression: the Esc-during-tools bug. A tool batch aborted mid-flight commits
  // its result LATE (via a detached addToolResults) — after the next turn already
  // appended messages — so the result lands out of order. Its id still matches, so
  // the old id-presence guard reported "safe" and the provider rejected the next
  // request with "insufficient tool messages following tool_calls". The adjacency
  // repair must MOVE the stray result back into position, preserving its content.
  it('moves an out-of-order tool result back adjacent to its tool_calls', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_A', type: 'function', function: { name: 'bash', arguments: '{}' } },
      ]},
      // next turn's messages landed BEFORE tc_A's (late) result
      { role: 'user', content: '继续' },
      { role: 'assistant', content: 'ok' },
      // the aborted batch's real result, appended out of order at the end
      { role: 'tool', tool_call_id: 'tc_A', content: 'real bash output' },
    ]
    // The id exists, so the old id-only detector saw no orphan call…
    assert.deepStrictEqual(detectOrphanToolCallsOai(messages), [])

    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.repaired, true)
    assert.strictEqual(report.syntheticResultsInserted, 0) // moved, not synthesized
    assert.strictEqual(report.safe, true)

    // The tool result must now IMMEDIATELY follow its assistant tool_calls, with
    // its real content intact, and there must be no stray tool message left.
    const m = report.messages
    assert.strictEqual(m[0]!.role, 'assistant')
    assert.strictEqual(m[1]!.role, 'tool')
    assert.strictEqual((m[1] as { tool_call_id: string }).tool_call_id, 'tc_A')
    assert.strictEqual((m[1] as { content: string }).content, 'real bash output')
    assert.strictEqual(m[2]!.role, 'user')
    assert.strictEqual(m[3]!.role, 'assistant')
    assert.strictEqual(m.filter(x => x.role === 'tool').length, 1)
  })

  it('synthesizes only for calls with no result anywhere, moving those that exist', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_A', type: 'function', function: { name: 'bash', arguments: '{}' } },
        { id: 'tc_B', type: 'function', function: { name: 'grep', arguments: '{}' } },
      ]},
      { role: 'user', content: 'steer' },
      // only tc_A's result arrived late; tc_B never produced one
      { role: 'tool', tool_call_id: 'tc_A', content: 'A output' },
    ]
    const report = runResumePreflightOai(messages)
    assert.strictEqual(report.repaired, true)
    assert.strictEqual(report.syntheticResultsInserted, 1) // only tc_B
    assert.strictEqual(report.safe, true)
    const m = report.messages
    assert.strictEqual(m[1]!.role, 'tool')
    assert.strictEqual((m[1] as { tool_call_id: string }).tool_call_id, 'tc_A')
    assert.strictEqual((m[1] as { content: string }).content, 'A output')
    assert.strictEqual(m[2]!.role, 'tool')
    assert.strictEqual((m[2] as { tool_call_id: string }).tool_call_id, 'tc_B')
    assert.ok((m[2] as { content: string }).content.includes('会话中断'))
    assert.strictEqual(m[3]!.role, 'user')
  })
})
