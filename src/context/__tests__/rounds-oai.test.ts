import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { groupIntoRoundsOai } from '../rounds.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('groupIntoRoundsOai', () => {
  it('groups user message as single-message round', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.startMessageIndex, 0)
    assert.strictEqual(rounds[0]!.endMessageIndex, 1)
    assert.strictEqual(rounds[0]!.hasToolCalls, false)
  })

  it('groups assistant message without tool_calls as single-message round', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: 'hi there' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.hasToolCalls, false)
  })

  it('groups assistant with tool_calls and matching tool results as one round', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.startMessageIndex, 0)
    assert.strictEqual(rounds[0]!.endMessageIndex, 2)
    assert.strictEqual(rounds[0]!.hasToolCalls, true)
    assert.strictEqual(rounds[0]!.hasToolResults, true)
    assert.strictEqual(rounds[0]!.apiInvariant, 'ok')
  })

  it('detects broken round with missing tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
      // tc_2 has no result
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.apiInvariant, 'broken')
  })

  it('detects orphan tool result as repaired round', () => {
    const messages: OaiMessage[] = [
      { role: 'tool', tool_call_id: 'tc_orphan', content: 'orphan result' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds.length, 1)
    assert.strictEqual(rounds[0]!.apiInvariant, 'repaired')
    assert.strictEqual(rounds[0]!.hasToolResults, true)
  })

  it('handles complex conversation with multiple rounds', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'Read file' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_1', type: 'function', function: { name: 'read_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_1', content: 'file content' },
      { role: 'assistant', content: 'Here is the file content' },
      { role: 'user', content: 'Write file' },
      { role: 'assistant', content: null, tool_calls: [
        { id: 'tc_2', type: 'function', function: { name: 'write_file', arguments: '{}' } },
      ]},
      { role: 'tool', tool_call_id: 'tc_2', content: 'written' },
      { role: 'assistant', content: 'Done' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    // system: 1, user1: 1, asst+tool: 1, asst: 1, user2: 1, asst+tool: 1, asst: 1
    assert.ok(rounds.length >= 5)
  })

  it('increments turn number on user messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply1' },
      { role: 'user', content: 'second' },
      { role: 'assistant', content: 'reply2' },
    ]
    const rounds = groupIntoRoundsOai(messages)
    assert.strictEqual(rounds[0]!.turnNumber, 1)
    assert.strictEqual(rounds[2]!.turnNumber, 2)
  })
})
