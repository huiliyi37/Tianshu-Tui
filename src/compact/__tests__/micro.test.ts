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

  it('truncates reasoning_content in non-recent assistant messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor reply' },
      // 3 history rounds (6 messages)
      ...Array.from({ length: 3 }, (_, i) => [
        { role: 'user' as const, content: `question ${i}` },
        { role: 'assistant' as const, content: `answer ${i}`, reasoning_content: longThinking },
      ] as OaiMessage[]).flat(),
      // 2 recent rounds (4 messages)
      ...Array.from({ length: 2 }, (_, i) => [
        { role: 'user' as const, content: `recent question ${i}` },
        { role: 'assistant' as const, content: `recent answer ${i}`, reasoning_content: longThinking },
      ] as OaiMessage[]).flat(),
    ]

    const { messages: compacted, truncated } = microCompactOai(messages, 128_000, 900_000)

    // History assistant messages (index 3,5,7) should have truncated reasoning
    const histAsst = compacted[3]!
    assert.ok(histAsst.role === 'assistant' && 'reasoning_content' in histAsst)
    assert.ok(histAsst.reasoning_content!.length < longThinking.length,
      `history reasoning should be truncated: got ${histAsst.reasoning_content!.length}, original ${longThinking.length}`)
    assert.ok(histAsst.reasoning_content!.length <= 600,
      `history reasoning should be ~500 chars: got ${histAsst.reasoning_content!.length}`)

    // Recent assistant messages (last 2) should have full reasoning
    const recentAsst = compacted[compacted.length - 1]!
    assert.ok(recentAsst.role === 'assistant' && 'reasoning_content' in recentAsst)
    assert.equal(recentAsst.reasoning_content!.length, longThinking.length,
      'recent reasoning should NOT be truncated')

    assert.ok(truncated > 0, 'should report truncated count > 0')
  })

  it('does not truncate reasoning in recent messages', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: 'hello', reasoning_content: longThinking },
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: 'answer', reasoning_content: longThinking },
    ]
    const { messages: compacted, truncated } = microCompactOai(messages, 128_000, 900_000)
    assert.equal(truncated, 0)

    const lastAsst = compacted[compacted.length - 1]!
    assert.ok(lastAsst.role === 'assistant' && 'reasoning_content' in lastAsst)
    assert.equal(lastAsst.reasoning_content!.length, longThinking.length)
  })

  it('handles short reasoning without truncation', () => {
    const shortThinking = 'Quick analysis done.'
    const messages: OaiMessage[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor reply' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: 'a1', reasoning_content: shortThinking },
      ...Array.from({ length: 4 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `filler ${i}`,
      })),
    ]

    const { messages: compacted } = microCompactOai(messages, 128_000, 900_000)
    const asst3 = compacted[3]!
    if (asst3.role === 'assistant' && asst3.reasoning_content) {
      assert.equal(asst3.reasoning_content, shortThinking)
    }
  })
})
