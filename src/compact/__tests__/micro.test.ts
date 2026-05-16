import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { microCompact, estimateTokens } from '../micro.js'
import type { Message } from '../../api/types.js'

describe('estimateTokens', () => {
  it('estimates tokens for short messages', () => {
    const msgs: Message[] = [{ role: 'user', content: 'Hello world' }]
    const est = estimateTokens(msgs)
    assert.ok(est > 0)
    assert.ok(est < 20)
  })

  it('handles empty messages array', () => {
    assert.equal(estimateTokens([]), 0)
  })

  it('handles content blocks (non-string content)', () => {
    const msgs: Message[] = [{
      role: 'assistant',
      content: [{ type: 'text', text: 'Hello' }],
    }]
    const est = estimateTokens(msgs)
    assert.ok(est > 0)
  })
})

describe('microCompact', () => {
  const makeMessages = (n: number): Message[] =>
    Array.from({ length: n }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}: ${'x'.repeat(100)}`,
    }))

  it('preserves anchor messages at start', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompact(msgs, 128_000, 900_000)
    assert.equal(messages[0]?.content, msgs[0]?.content)
    assert.equal(messages[1]?.content, msgs[1]?.content)
  })

  it('preserves recent messages at end', () => {
    const msgs = makeMessages(20)
    const { messages } = microCompact(msgs, 128_000, 900_000)
    const lastOriginal = msgs[msgs.length - 1]!.content
    const lastCompacted = messages[messages.length - 1]!.content
    assert.equal(lastCompacted, lastOriginal)
  })

  it('returns truncated count', () => {
    const msgs = makeMessages(20)
    const { truncated } = microCompact(msgs, 128_000, 900_000)
    assert.ok(truncated > 0)
    assert.ok(truncated < 20)
  })

  it('does nothing when few messages', () => {
    const msgs = makeMessages(4)
    const { messages, truncated } = microCompact(msgs, 128_000, 900_000)
    assert.equal(messages.length, 4)
    assert.equal(truncated, 0)
  })
})
