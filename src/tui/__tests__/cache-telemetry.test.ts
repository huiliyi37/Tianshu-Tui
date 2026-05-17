import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { projectCacheTelemetry, type CacheTelemetrySession } from '../cache-telemetry.js'

function session(overrides: Partial<CacheTelemetrySession>): CacheTelemetrySession {
  return {
    getCacheHistory: () => [],
    getRecentTurnHitRate: () => null,
    getCacheHitRate: () => 0,
    getLatestTurnHitRate: () => null,
    wasCompactedAt: () => false,
    ...overrides,
  }
}

describe('projectCacheTelemetry', () => {
  it('marks cache telemetry stale when the latest turn has no cache snapshot but history exists', () => {
    const projected = projectCacheTelemetry(session({
      getCacheHistory: () => [{ turn: 1, cacheRead: 100, cacheCreation: 0, inputTokens: 100, outputTokens: 10 }],
      getRecentTurnHitRate: () => 1,
      getCacheHitRate: () => 1,
      getLatestTurnHitRate: () => 1,
    }), 2, 'healthy')

    assert.equal(projected.status, 'stale')
    assert.equal(projected.hitRate, 1)
  })

  it('marks cache telemetry stale when current snapshot has no counters and prior counters exist', () => {
    const projected = projectCacheTelemetry(session({
      getCacheHistory: () => [
        { turn: 1, cacheRead: 100, cacheCreation: 0, inputTokens: 100, outputTokens: 10 },
        { turn: 2, cacheRead: 0, cacheCreation: 0, inputTokens: 100, outputTokens: 10 },
      ],
      getRecentTurnHitRate: () => 1,
      getCacheHitRate: () => 1,
      getLatestTurnHitRate: () => null,
    }), 2, 'healthy')

    assert.equal(projected.status, 'stale')
  })

  it('marks current low cache hit as degraded instead of stale', () => {
    const projected = projectCacheTelemetry(session({
      getCacheHistory: () => [{ turn: 2, cacheRead: 10, cacheCreation: 90, inputTokens: 100, outputTokens: 10 }],
      getRecentTurnHitRate: () => 0.1,
      getCacheHitRate: () => 0.1,
      getLatestTurnHitRate: () => 0.1,
    }), 2, 'healthy')

    assert.equal(projected.status, 'degraded')
    assert.equal(projected.hitRate, 0.1)
  })
})
