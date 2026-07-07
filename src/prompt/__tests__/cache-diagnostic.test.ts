import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { diagnoseCacheMiss } from '../cache-diagnostic.js'

describe('diagnoseCacheMiss', () => {
  it('reports first_turn on a single turn with cache counters present', () => {
    // A single-turn history with non-zero counters has no prior prefix to hit yet:
    // the real semantic is first_turn (cache being built), not low-hit-rate.
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 20, cacheCreation: 80, inputTokens: 100, outputTokens: 10 },
    ], 1, null, false)

    assert.ok(diagnostic)
    assert.equal(diagnostic!.reason, 'first_turn')
  })

  it('returns null on first turn when provider reports no cache counters', () => {
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 0, cacheCreation: 0, inputTokens: 100, outputTokens: 10 },
    ], 1, null, false)

    assert.equal(diagnostic, null)
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

  it('diagnoses cacheRead regression as prefix_truncation (TTL expiry / mid-history divergence)', () => {
    // cacheRead dropped 500 → 50: on an append-only conversation this is a
    // monotonicity violation — the shared prefix stopped matching mid-history.
    // (Anthropic TTL expiry and DeepSeek落盘 unit mismatch both surface here.)
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 500, cacheCreation: 20, inputTokens: 520, outputTokens: 20 },
      { turn: 2, cacheRead: 50, cacheCreation: 450, inputTokens: 500, outputTokens: 20 },
    ], 2, null, false)

    assert.ok(diagnostic)
    assert.equal(diagnostic!.reason, 'prefix_truncation')
    assert.equal(diagnostic!.severity, 'error')
    assert.match(diagnostic!.message, /500 → 50/)
  })

  it('diagnoses prefix_truncation at moderate hit rates (8396ac51 idx35 regression)', () => {
    // Real numbers from session 8396ac51: cacheRead 60928 → 35712 with a
    // 53.9% hit rate. The old logic fell through to normal_growth because the
    // rate sat between the 0.4 eviction floor and the 0.8 healthy ceiling,
    // hiding a 25K-token mid-history divergence.
    const diagnostic = diagnoseCacheMiss([
      { turn: 34, cacheRead: 60928, cacheCreation: 161, inputTokens: 61089, outputTokens: 130 },
      { turn: 35, cacheRead: 35712, cacheCreation: 30504, inputTokens: 66216, outputTokens: 879 },
    ], 35, null, false)

    assert.ok(diagnostic)
    assert.equal(diagnostic!.reason, 'prefix_truncation')
  })

  it('diagnoses low cache hit WITHOUT regression as cache_eviction (cold-start pattern)', () => {
    // cacheRead grew (50 → 60) so the prefix is intact — the low rate comes
    // from a large cold rebuild, not a mid-history divergence.
    const diagnostic = diagnoseCacheMiss([
      { turn: 1, cacheRead: 50, cacheCreation: 20, inputTokens: 70, outputTokens: 20 },
      { turn: 2, cacheRead: 60, cacheCreation: 450, inputTokens: 510, outputTokens: 20 },
    ], 2, null, false)

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
