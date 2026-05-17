import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { deepStripUnsupported, canonicalizeRequest } from '../request-freezer.js'
import type { MessageRequest } from '../types.js'

function makeRequest(overrides: Partial<MessageRequest> = {}): MessageRequest {
  return {
    model: 'deepseek-chat',
    messages: [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi', cache_control: { type: 'ephemeral' } },
    ],
    max_tokens: 4096,
    system: 'You are helpful.',
    tools: [{ name: 'read_file', description: 'Read a file', input_schema: { type: 'object', properties: {}, required: [] } }],
    stream: true,
    ...overrides,
  }
}

describe('deepStripUnsupported', () => {
  it('strips top-level unsupported fields', () => {
    const req = makeRequest({ temperature: 0.7 })
    const result = deepStripUnsupported(req, ['temperature'])
    const r = result as unknown as Record<string, unknown>
    assert.equal(r.temperature, undefined)
    assert.equal(result.model, 'deepseek-chat')
  })

  it('strips cache_control from individual messages', () => {
    const req = makeRequest()
    assert.ok(req.messages[1] && 'cache_control' in req.messages[1])

    const result = deepStripUnsupported(req, ['cache_control'])
    assert.ok(result.messages[1] && !('cache_control' in result.messages[1]))
  })

  it('does not strip when unsupported list is empty', () => {
    const req = makeRequest()
    const result = deepStripUnsupported(req, [])
    assert.deepEqual(result, req)
  })

  it('does not strip fields not in unsupported list', () => {
    const req = makeRequest({ temperature: 0.7 })
    const result = deepStripUnsupported(req, ['top_k'])
    const r = result as unknown as Record<string, unknown>
    assert.equal(r.temperature, 0.7)
  })
})

describe('canonicalizeRequest', () => {
  it('strips cache_control for exact-prefix provider (DeepSeek)', () => {
    const req = makeRequest()
    const result = canonicalizeRequest(req,
      { cacheType: 'exact-prefix', persistent: true, minCacheTokens: 64, contextWindow: 1_000_000 },
      ['cache_control', 'top_k'],
    )
    // cache_control should be stripped from messages
    assert.ok(!('cache_control' in result.messages[1]!))
  })

  it('preserves cache_control injection for explicit-breakpoint provider (Anthropic)', () => {
    const req = makeRequest({
      messages: [
        { role: 'user', content: 'msg1' },
        { role: 'user', content: 'msg2' },
        { role: 'assistant', content: 'reply' },
      ],
    })
    const result = canonicalizeRequest(req,
      { cacheType: 'explicit-breakpoint', persistent: false, minCacheTokens: 1024, ttlSeconds: 300, contextWindow: 200_000 },
      [],
    )
    // explicit-breakpoint injects cache_control on anchor message (CACHE_ANCHOR_MESSAGES - 1 = index 1)
    assert.ok('cache_control' in result.messages[1]!)
  })
})
