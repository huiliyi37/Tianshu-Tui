import type { TurnCacheSnapshot } from '../agent/context.js'
import type { CacheStatus } from './status-types.js'

export interface CacheTelemetrySession {
  getCacheHistory(): TurnCacheSnapshot[]
  getRecentTurnHitRate(lastN: number): number | null
  getCacheHitRate(): number
  getLatestTurnHitRate(): number | null
  wasCompactedAt(turn: number): boolean
}

export interface CacheTelemetryProjection {
  hitRate: number
  status: CacheStatus
  latestHitRate: number | null
  wasCompacted: boolean
}

export function projectCacheTelemetry(
  session: CacheTelemetrySession,
  turnNumber: number,
  previousStatus: CacheStatus,
): CacheTelemetryProjection {
  const history = session.getCacheHistory()
  const latestSnapshot = history[history.length - 1]
  const latestSnapshotTotal = latestSnapshot
    ? latestSnapshot.cacheRead + latestSnapshot.cacheCreation
    : 0
  const hasHistoricalCounters = history.some(s => s.cacheRead + s.cacheCreation > 0)
  const hasCurrentCounters = latestSnapshot?.turn === turnNumber && latestSnapshotTotal > 0
  const hitRate = session.getRecentTurnHitRate(3) ?? session.getCacheHitRate()
  const latestHitRate = hasCurrentCounters ? session.getLatestTurnHitRate() : null
  const wasCompacted = turnNumber > 1 && session.wasCompactedAt(turnNumber - 1)

  if (!hasCurrentCounters && hasHistoricalCounters) {
    return { hitRate, status: 'stale', latestHitRate: null, wasCompacted }
  }

  if (latestHitRate !== null && latestHitRate < 0.4 && turnNumber > 1) {
    return { hitRate, status: 'degraded', latestHitRate, wasCompacted }
  }

  if (latestHitRate !== null && latestHitRate >= 0.6) {
    return {
      hitRate,
      status: previousStatus === 'degraded' ? 'recovering' : 'healthy',
      latestHitRate,
      wasCompacted,
    }
  }

  return { hitRate, status: 'healthy', latestHitRate, wasCompacted }
}
