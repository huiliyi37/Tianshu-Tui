import type { TurnCacheSnapshot } from '../agent/context.js'
import type { DriftEvent } from './fingerprint.js'

export type CacheMissReason =
  | 'first_turn'
  | 'prefix_drift'
  | 'prefix_truncation'
  | 'compaction'
  | 'normal_growth'
  | 'cache_eviction'
  | 'no_data'

export interface CacheDiagnostic {
  reason: CacheMissReason
  message: string
  severity: 'info' | 'warn' | 'error'
  turnHitRate: number
}

export function diagnoseCacheMiss(
  history: TurnCacheSnapshot[],
  currentTurn: number,
  drift: DriftEvent | null,
  wasCompacted: boolean,
): CacheDiagnostic | null {
  if (history.length === 0) return null

  const current = history[history.length - 1]!

  // Provider reported no cache counters at all — nothing to diagnose
  if (current.cacheRead + current.cacheCreation === 0) return null

  // First turn — no cache to hit
  if (history.length === 1) {
    return {
      reason: 'first_turn',
      message: 'First turn — building prefix cache',
      severity: 'info',
      turnHitRate: 0,
    }
  }

  const turnTotal = current.cacheRead + current.cacheCreation
  const turnHitRate = turnTotal > 0 ? current.cacheRead / turnTotal : 1

  // High hit rate — nothing to explain
  if (turnHitRate >= 0.8) return null

  // Check fingerprint drift first — this invalidates the entire prefix
  if (drift) {
    const parts: string[] = []
    if (drift.systemChanged) parts.push('system prompt')
    if (drift.toolsChanged) parts.push('tool definitions')
    if (drift.stableVolatileChanged) parts.push('stable volatile context')
    return {
      reason: 'prefix_drift',
      message: `Cache drift: ${parts.join(' + ')} changed — prefix invalidated`,
      severity: 'error',
      turnHitRate,
    }
  }

  // Check if compaction happened this turn
  if (wasCompacted) {
    return {
      reason: 'compaction',
      message: 'Compaction ran — message history restructured, partial cache miss expected',
      severity: 'warn',
      turnHitRate,
    }
  }

  // Prefix truncation: cacheRead REGRESSED vs the previous turn. On an
  // append-only conversation cacheRead is monotonic — a drop means the shared
  // prefix stopped matching mid-history (client byte churn or provider-side
  // re-rendering), which is categorically different from tail growth. The
  // 8396ac51 investigation (2026-07-06) found these were mislabeled
  // normal_growth, hiding ~30K-token rebuild events.
  const prev = history[history.length - 2]!
  if (current.cacheRead < prev.cacheRead) {
    const lost = prev.cacheRead - current.cacheRead
    return {
      reason: 'prefix_truncation',
      message: `Prefix truncation: cacheRead dropped ${lost} tokens (${prev.cacheRead} → ${current.cacheRead}) — mid-history divergence, check prefixDiverged/wireDiverged breadcrumbs`,
      severity: 'error',
      turnHitRate,
    }
  }

  // Low hit rate with no obvious cause — likely cache eviction from long context
  if (turnHitRate < 0.4) {
    return {
      reason: 'cache_eviction',
      message: `Low cache hit (${(turnHitRate * 100).toFixed(0)}%) — prefix may have been evicted from cache due to context length`,
      severity: 'warn',
      turnHitRate,
    }
  }

  // Moderate miss — normal new messages growing
  return {
    reason: 'normal_growth',
    message: `Cache hit ${(turnHitRate * 100).toFixed(0)}% — new messages partially outside cached prefix`,
    severity: 'info',
    turnHitRate,
  }
}
