import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { microCompactOai, estimateOaiTokens } from '../micro.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('estimateOaiTokens', () => {
  it('estimates tokens for short messages', () => {
    const msgs: OaiMessage[] = [{ role: 'user', content: 'Hello world' }]
    const est = estimateOaiTokens(msgs)
    assert.ok(est > 0)
    assert.ok(est < 20)
  })

  it('handles empty messages array', () => {
    assert.equal(estimateOaiTokens([]), 0)
  })

  it('handles assistant messages with reasoning', () => {
    const msgs: OaiMessage[] = [{
      role: 'assistant',
      content: 'Hello',
      reasoning_content: 'Let me think...',
    }]
    const est = estimateOaiTokens(msgs)
    assert.ok(est > 0)
  })
})

describe('microCompactOai', () => {
  const makeMessages = (n: number): OaiMessage[] =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'x'.repeat(100)}`,
    }))

  it('preserves anchor messages at start', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompactOai(msgs, 128_000, 900_000)
    assert.equal(messages[0]?.content, msgs[0]?.content)
    assert.equal(messages[1]?.content, msgs[1]?.content)
  })

  it('preserves recent messages at end', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompactOai(msgs, 128_000, 900_000)
    const lastOriginal = msgs[msgs.length - 1]!.content
    const lastCompacted = messages[messages.length - 1]!.content
    assert.equal(lastCompacted, lastOriginal)
  })

  it('returns truncated count', () => {
    const msgs = makeMessages(20)
    const { truncated } = microCompactOai(msgs, 128_000, 900_000)
    assert.ok(truncated > 0)
    assert.ok(truncated < 20)
  })

  it('does nothing when few messages', () => {
    const msgs = makeMessages(4)
    const { messages, truncated } = microCompactOai(msgs, 128_000, 900_000)
    assert.equal(messages.length, 4)
    assert.equal(truncated, 0)
  })
})

describe('reasoning compaction', () => {
  const longThinking = 'Let me analyze this step by step. '.repeat(200) // ~8K chars

  it('preserves reasoning_content intact (no truncation)', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor reply' },
      ...Array.from({ length: 3 }, (_, i) => [
        { role: 'user' as const, content: `question ${i}` },
        { role: 'assistant' as const, content: `answer ${i}`, reasoning_content: longThinking },
      ] as OaiMessage[]).flat(),
      ...Array.from({ length: 2 }, (_, i) => [
        { role: 'user' as const, content: `recent question ${i}` },
        { role: 'assistant' as const, content: `recent answer ${i}`, reasoning_content: longThinking },
      ] as OaiMessage[]).flat(),
    ]

    const { messages: compacted } = microCompactOai(messages, 128_000, 900_000)

    for (const msg of compacted) {
      if (msg.role === 'assistant' && msg.reasoning_content) {
        assert.equal(msg.reasoning_content.length, longThinking.length,
          'reasoning_content must never be truncated')
      }
    }
  })
})
