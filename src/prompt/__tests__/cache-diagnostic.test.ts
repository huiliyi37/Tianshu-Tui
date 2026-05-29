import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseCacheMiss } from '../cache-diagnostic.js'

describe('diagnoseCacheMiss', () => {
  it('reports low hit rate on latest turn', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 20, cacheCreation: 80, inputTokens: 100, outputTokens: 10 },
    ], 1, null, false)

    assert.ok(diagnostic)
    assert.match(diagnostic!.message, /cache/i)
  })

  it('returns null when hit rate is healthy', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 20, cacheCreation: 80, inputTokens: 100, outputTokens: 10 },
      { turn: 2, cacheRead: 90, cacheCreation: 10, inputTokens: 100, outputTokens: 10 },
    ], 2, null, false)

    assert.equal(diagnostic, null)
  })

  it('diagnoses Anthropic-style high cache_read as healthy', () => {
    // Simulate Anthropic cache pattern: high cache_read, low cache_creation
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 500, cacheCreation: 50, inputTokens: 550, outputTokens: 20 },
      { turn: 2, cacheRead: 450, cacheCreation: 30, inputTokens: 480, outputTokens: 15 },
    ], 2, null, false)

    // Hit rate = 450/(450+30) = 0.9375 > 0.8 → healthy → null
    assert.equal(diagnostic, null)
  })

  it('diagnoses low cache hit as cache_eviction (Anthropic TTL expiry scenario)', () => {
    // Simulate TTL expiry: high cache_creation, low cache_read
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 500, cacheCreation: 20, inputTokens: 520, outputTokens: 20 },
      { turn: 2, cacheRead: 50, cacheCreation: 450, inputTokens: 500, outputTokens: 20 },
    ], 2, null, false)

    // Hit rate = 50/(50+450) = 0.1 < 0.4 → cache_eviction
    assert.ok(diagnostic)
    assert.equal(diagnostic!.reason, 'cache_eviction')
  })

  it('diagnoses prefix_drift when toolsChanged drift is reported', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 500, cacheCreation: 50, inputTokens: 550, outputTokens: 20 },
      { turn: 2, cacheRead: 50, cacheCreation: 450, inputTokens: 500, outputTokens: 20 },
    ], 2, {
      systemChanged: false,
      toolsChanged: true,
      stableVolatileChanged: false,
      message: 'Prefix cache drift detected: tool definitions changed',
    }, false)

    assert.ok(diagnostic)
    assert.equal(diagnostic!.reason, 'prefix_drift')
    assert.match(diagnostic!.message, /tool definitions/)
  })
})
