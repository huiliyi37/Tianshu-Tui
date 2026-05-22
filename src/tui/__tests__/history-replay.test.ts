import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { replayMessagesToLogEntries } from '../history-replay.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('replayMessagesToLogEntries', () => {
  it('handles empty messages', () => {
    const result = replayMessagesToLogEntries([])
    assert.equal(result.entries.length, 0)
    assert.equal(result.turnCount, 0)
    assert.equal(result.toolCount, 0)
  })

  it('replays user text messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]!.content, 'hello')
    assert.equal(result.turnCount, 1)
  })

  it('replays assistant text blocks', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'Hello!' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]!.content, 'Hello!')
  })

  it('replays tool results', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 't1', content: 'file1.ts\nfile2.ts' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]!.type, 'tool')
    assert.equal(result.entries[1]!.isError, false)
    assert.equal(result.toolCount, 1)
  })

  it('replays tool results without error flag', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'fail' },
      { role: 'assistant', content: null, tool_calls: [{ id: 't2', type: 'function', function: { name: 'bash', arguments: '{"command":"bad"}' } }] },
      { role: 'tool', tool_call_id: 't2', content: 'command not found' },
    ]
    const result = replayMessagesToLogEntries(messages)
    // OAI format has no is_error field; replay always sets isError to false
    assert.equal(result.entries[1]!.isError, false)
  })

  it('preserves thinking blocks in assistant messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: 'Here is my answer.',
        reasoning_content: 'Let me think about this...',
      },
    ]
    const { entries } = replayMessagesToLogEntries(messages)
    const assistantEntry = entries.find(e => e.type === 'assistant_message')!
    assert.strictEqual(assistantEntry.content, 'Here is my answer.')
    assert.strictEqual(assistantEntry.thinking, 'Let me think about this...')
  })

  it('handles thinking-only messages without text', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        reasoning_content: 'Analyzing...',
      },
    ]
    const { entries } = replayMessagesToLogEntries(messages)
    const assistantEntry = entries.find(e => e.type === 'assistant_message')
    assert.ok(assistantEntry, 'should create entry for thinking-only message')
    assert.strictEqual(assistantEntry!.thinking, 'Analyzing...')
  })

  it('handles multi-turn conversation', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: 'reply 1' },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: 'reply 2' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.turnCount, 2)
    assert.equal(result.entries.length, 4)
  })

  it('skips system messages', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'hello' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]!.content, 'hello')
  })
})
