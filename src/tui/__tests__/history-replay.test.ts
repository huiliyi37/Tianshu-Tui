import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { replayMessagesToLogEntries } from '../history-replay.js'
import type { Message } from '../../api/types.js'

describe('replayMessagesToLogEntries', () => {
  it('handles empty messages', () => {
    const result = replayMessagesToLogEntries([])
    assert.equal(result.entries.length, 0)
    assert.equal(result.turnCount, 0)
    assert.equal(result.toolCount, 0)
  })

  it('replays user text messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 1)
    assert.equal(result.entries[0]!.content, 'hello')
    assert.equal(result.turnCount, 1)
  })

  it('replays assistant text blocks', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [{ type: 'text', text: 'Hello!' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]!.content, 'Hello!')
  })

  it('replays tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'do it' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'bash', input: { command: 'ls' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'file1.ts\nfile2.ts' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries.length, 2)
    assert.equal(result.entries[1]!.type, 'tool')
    assert.equal(result.entries[1]!.isError, false)
    assert.equal(result.toolCount, 1)
  })

  it('replays error tool results', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fail' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 't2', name: 'bash', input: { command: 'bad' } }] },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't2', content: 'command not found', is_error: true }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.entries[1]!.isError, true)
  })

  it('preserves thinking blocks in assistant messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Let me think about this...' },
          { type: 'text', text: 'Here is my answer.' },
        ],
      },
    ]
    const { entries } = replayMessagesToLogEntries(messages)
    const assistantEntry = entries.find(e => e.type === 'assistant_message')!
    assert.strictEqual(assistantEntry.content, 'Here is my answer.')
    assert.strictEqual(assistantEntry.thinking, 'Let me think about this...')
  })

  it('handles thinking-only messages without text', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'Analyzing...' },
        ],
      },
    ]
    const { entries } = replayMessagesToLogEntries(messages)
    const assistantEntry = entries.find(e => e.type === 'assistant_message')
    assert.ok(assistantEntry, 'should create entry for thinking-only message')
    assert.strictEqual(assistantEntry!.thinking, 'Analyzing...')
  })

  it('handles multi-turn conversation', () => {
    const messages: Message[] = [
      { role: 'user', content: 'turn 1' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 1' }] },
      { role: 'user', content: 'turn 2' },
      { role: 'assistant', content: [{ type: 'text', text: 'reply 2' }] },
    ]
    const result = replayMessagesToLogEntries(messages)
    assert.equal(result.turnCount, 2)
    assert.equal(result.entries.length, 4)
  })
})
