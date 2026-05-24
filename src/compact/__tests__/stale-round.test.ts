import { describe, it } from 'node:test'
import { strict as assert } from 'node:assert'
import { compactStaleRoundsOai } from '../stale-round.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('compactStaleRoundsOai', () => {
  function toolMsg(id: string, content: string): OaiMessage {
    return { role: 'tool', tool_call_id: id, content }
  }

  function assistantMsg(text: string): OaiMessage {
    return { role: 'assistant', content: text }
  }

  it('preserves cache anchor messages (first 2) untouched', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      assistantMsg('hi'),
      toolMsg('tu_1', 'x'.repeat(5000)),
      assistantMsg('done'),
      toolMsg('tu_2', 'y'.repeat(5000)),
      assistantMsg('final'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.strictEqual(result[0], messages[0])
    assert.strictEqual(result[1], messages[1])
  })

  it('compacts tool messages in stale rounds (N-2+) to ~1200 chars', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg('tu_1', 'A'.repeat(5000)),
      assistantMsg('round1'),
      toolMsg('tu_2', 'B'.repeat(5000)),
      assistantMsg('round2'),
      toolMsg('tu_3', 'C'.repeat(5000)),
      assistantMsg('round3'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.ok(result[2]!.content!.length <= 1400, `Expected <=1400, got ${result[2]!.content!.length}`)
    assert.strictEqual(result[4]!.content!.length, 5000)
    assert.strictEqual(result[6]!.content!.length, 5000)
  })

  it('returns same array reference if nothing to compact', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      toolMsg('tu_1', 'short'),
      assistantMsg('done'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.strictEqual(result, messages)
  })

  it('handles messages with string content', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor1' },
      assistantMsg('anchor2'),
      { role: 'user', content: 'plain string message' },
      assistantMsg('round1'),
      toolMsg('tu_1', 'C'.repeat(5000)),
      assistantMsg('current'),
    ]
    const result = compactStaleRoundsOai(messages, 64_000)
    assert.ok(result.length === messages.length)
  })
})
