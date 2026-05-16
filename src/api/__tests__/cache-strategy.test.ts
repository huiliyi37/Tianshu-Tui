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
