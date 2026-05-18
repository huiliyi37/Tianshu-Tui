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

describe('thinking block compaction', () => {
  const longThinking = 'Let me analyze this step by step. '.repeat(200) // ~8K chars

  it('truncates thinking blocks in non-recent assistant messages', () => {
    // Build messages: 2 anchor + 6 history + 4 recent = 12 total
    const messages: Message[] = [
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: longThinking },
        { type: 'text', text: 'anchor reply' },
      ]},
      // 3 history rounds (6 messages)
      ...Array.from({ length: 3 }, (_, i) => [
        { role: 'user' as const, content: `question ${i}` },
        { role: 'assistant' as const, content: [
          { type: 'thinking' as const, thinking: longThinking },
          { type: 'text' as const, text: `answer ${i}` },
        ] },
      ] as Message[]).flat(),
      // 2 recent rounds (4 messages)
      ...Array.from({ length: 2 }, (_, i) => [
        { role: 'user' as const, content: `recent question ${i}` },
        { role: 'assistant' as const, content: [
          { type: 'thinking' as const, thinking: longThinking },
          { type: 'text' as const, text: `recent answer ${i}` },
        ] },
      ] as Message[]).flat(),
    ]
    // total = 12 messages

    const { messages: compacted, truncated } = microCompact(messages, 128_000, 900_000)

    // History assistant messages (index 3,5,7) should have truncated thinking
    const histAsst = compacted[3]!
    assert.ok(Array.isArray(histAsst.content))
    const thinkingBlock = (histAsst.content as any[]).find((b: any) => b.type === 'thinking')
    assert.ok(thinkingBlock, 'history assistant should still have thinking block')
    assert.ok(thinkingBlock.thinking.length < longThinking.length,
      `history thinking should be truncated: got ${thinkingBlock.thinking.length}, original ${longThinking.length}`)
    assert.ok(thinkingBlock.thinking.length <= 600,
      `history thinking should be ~500 chars: got ${thinkingBlock.thinking.length}`)

    // Recent assistant messages (last 2) should have full thinking
    const recentAsst = compacted[compacted.length - 1]!
    assert.ok(Array.isArray(recentAsst.content))
    const recentThinking = (recentAsst.content as any[]).find((b: any) => b.type === 'thinking')
    assert.ok(recentThinking, 'recent assistant should have thinking block')
    assert.equal(recentThinking.thinking.length, longThinking.length,
      'recent thinking should NOT be truncated')

    assert.ok(truncated > 0, 'should report truncated count > 0')
  })

  it('does not truncate thinking in recent messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'hi' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: longThinking },
        { type: 'text', text: 'hello' },
      ]},
      { role: 'user', content: 'follow up' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: longThinking },
        { type: 'text', text: 'answer' },
      ]},
    ]
    // Only 4 messages = KEEP_RECENT_MESSAGES, nothing should be truncated
    const { messages: compacted, truncated } = microCompact(messages, 128_000, 900_000)
    assert.equal(truncated, 0)

    const lastAsst = compacted[compacted.length - 1]!
    const thinkingBlock = (lastAsst.content as any[]).find((b: any) => b.type === 'thinking')
    assert.equal(thinkingBlock!.thinking.length, longThinking.length)
  })

  it('handles short thinking blocks without truncation', () => {
    const shortThinking = 'Quick analysis done.'
    const messages: Message[] = [
      { role: 'user', content: 'anchor' },
      { role: 'assistant', content: 'anchor reply' },
      { role: 'user', content: 'q1' },
      { role: 'assistant', content: [
        { type: 'thinking', thinking: shortThinking },
        { type: 'text', text: 'a1' },
      ]},
      ...Array.from({ length: 4 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: `filler ${i}`,
      })),
    ]

    const { messages: compacted } = microCompact(messages, 128_000, 900_000)
    const asst3 = compacted[3]!
    if (Array.isArray(asst3.content)) {
      const tb = (asst3.content as any[]).find((b: any) => b.type === 'thinking')
      // Short thinking should pass through unchanged (truncation would make it longer)
      if (tb) assert.equal(tb.thinking, shortThinking)
    }
  })
})
