import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactStaleRounds } from '../stale-round.js'
import type { Message } from '../../api/types.js'

describe('compactStaleRounds', () => {
  function toolResultMsg(content: string): Message {
    return { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu_1', content }] }
  }

  function assistantMsg(text: string): Message {
    return { role: 'assistant', content: [{ type: 'text', text }] }
  }

  it('preserves cache anchor messages (first 2) untouched', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolResultMsg('x'.repeat(5000)),
      assistantMsg('done'),
      toolResultMsg('y'.repeat(5000)),
      assistantMsg('final'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    assert.strictEqual(result[0], messages[0])
    assert.strictEqual(result[1], messages[1])
  })

  it('compacts tool_result in stale rounds (N-2+) to ~1200 chars', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      // Stale round (N-2)
      toolResultMsg('A'.repeat(5000)),
      assistantMsg('round1'),
      // Recent round (N-1)
      toolResultMsg('B'.repeat(5000)),
      assistantMsg('round2'),
      // Current round (N)
      toolResultMsg('C'.repeat(5000)),
      assistantMsg('round3'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    // Stale round tool_result should be compacted
    const staleBlock = (result[2]!.content as any[])[0]
    assert.ok(staleBlock.content.length <= 1400, `Expected <=1400, got ${staleBlock.content.length}`)
    // Recent rounds should be untouched
    const recentBlock = (result[4]!.content as any[])[0]
    assert.strictEqual(recentBlock.content.length, 5000)
    const currentBlock = (result[6]!.content as any[])[0]
    assert.strictEqual(currentBlock.content.length, 5000)
  })

  it('returns same array reference if nothing to compact', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolResultMsg('short'),
      assistantMsg('done'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    assert.strictEqual(result, messages)
  })

  it('handles messages with string content (not array)', () => {
    const messages: Message[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      { role: 'user', content: 'plain string message' },
      assistantMsg('round1'),
      toolResultMsg('C'.repeat(5000)),
      assistantMsg('current'),
    ]
    const result = compactStaleRounds(messages, 1_000_000)
    // Should not crash on string content messages
    assert.ok(result.length === messages.length)
  })
})
