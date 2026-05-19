import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { applyCacheStrategy } from '../cache-strategy.js'
import type { Message } from '../types.js'

describe('applyCacheStrategy', () => {
  const messages: Message[] = [
    { role: 'user', content: 'system prompt here' },
    { role: 'assistant', content: 'acknowledged' },
    { role: 'user', content: 'do something' },
  ]

  it('deepseek: returns messages unchanged (auto prefix cache)', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64, contextWindow: 1_000_000 })
    assert.deepEqual(result, messages)
  })

  it('anthropic: injects cache_control after anchor messages', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, contextWindow: 200_000 })
    assert.ok(result[1] && 'cache_control' in result[1])
  })

  it('none: returns messages unchanged', () => {
    const result = applyCacheStrategy(messages, { cacheType: 'none', persistent: false, minCacheTokens: 0, contextWindow: 32_000 })
    assert.deepEqual(result, messages)
  })
})

describe('applyExplicitBreakpoints — frozen/working boundary', () => {
  const bp = { cacheType: 'explicit-breakpoint' as const, persistent: false, minCacheTokens: 0, contextWindow: 200_000 }

  it('places breakpoint on last assistant in frozen zone (multi-turn)', () => {
    const messages: Message[] = [
      { role: 'user', content: '<context>frozen</context>' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },          // ← should get breakpoint
      { role: 'user', content: '<context>fresh</context>' },
      { role: 'user', content: 'read file' },
    ]
    const result = applyCacheStrategy(messages, bp)
    assert.ok((result[2] as any).cache_control, 'breakpoint should be on message[2]')
    assert.equal((result[2] as any).cache_control.type, 'ephemeral')
    // No other message should have cache_control
    assert.equal((result[0] as any).cache_control, undefined)
    assert.equal((result[4] as any).cache_control, undefined)
  })

  it('falls back to anchor index for single-turn (no historical messages)', () => {
    const messages: Message[] = [
      { role: 'user', content: '<context>volatile</context>' },
      { role: 'user', content: 'hello' },
    ]
    const result = applyCacheStrategy(messages, bp)
    assert.ok((result[1] as any).cache_control, 'fallback: breakpoint on index 1')
  })

  it('handles 3-turn conversation correctly', () => {
    const messages: Message[] = [
      { role: 'user', content: '<context>frozen</context>' },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: '<context>frozen</context>' },
      { role: 'user', content: 'read file' },
      { role: 'assistant', content: 'here is the file' },    // ← should get breakpoint
      { role: 'user', content: '<context>fresh</context>' },
      { role: 'user', content: 'fix the bug' },
    ]
    const result = applyCacheStrategy(messages, bp)
    assert.ok((result[5] as any).cache_control, 'breakpoint should be on message[5] (last frozen assistant)')
  })
})
