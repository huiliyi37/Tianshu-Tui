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
    assert.ok(toolResult.content.includes('recovered'))
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
})
