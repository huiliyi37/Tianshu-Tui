import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactStaleRoundsOai } from '../stale-round.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('compactStaleRoundsOai', () => {
  function toolMsg(content: string, toolCallId = 'tc_1'): OaiMessage {
    return { role: 'tool', tool_call_id: toolCallId, content }
  }

  function assistantMsg(text: string): OaiMessage {
    return { role: 'assistant', content: text }
  }

  it('preserves cache anchor messages (first 2) untouched', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'You are helpful' },
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolMsg('x'.repeat(5000)),
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    assert.strictEqual(result[0], messages[0])
    assert.strictEqual(result[1], messages[1])
  })

  it('compacts tool messages in stale rounds (N-2+) to ~1200 chars', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg('x'.repeat(5000)),
      assistantMsg('done'),
      toolMsg('y'.repeat(5000)),
      assistantMsg('final'),
      toolMsg('z'.repeat(300)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    // Stale tool messages should be truncated
    const staleMsg = result[3]!
    assert.ok(staleMsg.role === 'tool')
    assert.ok(staleMsg.content.length < 5000)
    assert.ok(staleMsg.content.includes('stale-compacted'))
    // Recent tool messages should be untouched
    const recentMsg = result[7]!
    assert.ok(recentMsg.role === 'tool')
    assert.strictEqual(recentMsg.content.length, 300)
  })

  it('returns same array when no changes needed', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolMsg('x'.repeat(100)),
      assistantMsg('done'),
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    assert.strictEqual(result, messages) // Same reference
  })

  it('returns same array when too few messages', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'hello' },
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    assert.strictEqual(result, messages)
  })

  it('preserves non-tool messages untouched', () => {
    const messages: OaiMessage[] = [
      { role: 'system', content: 'sys' },
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      { role: 'user', content: 'stale user' },
      assistantMsg('stale asst'),
      assistantMsg('recent asst'),
      toolMsg('z'.repeat(100)),
      assistantMsg('end'),
    ]
    const result = compactStaleRoundsOai(messages, 1_000_000)
    // User and assistant messages should be untouched
    assert.strictEqual(result[3]!.role, 'user')
    assert.strictEqual(result[4]!.role, 'assistant')
  })
})
