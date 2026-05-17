import type { ActivityPhase } from './activity-status.js'

// --- Fluency Policy ---

export type FluencyVisibility = 'normal' | 'quiet' | 'inspect' | 'stress'

export interface FluencySignals {
  phase: ActivityPhase
  silentMs: number
  outputRate: number       // chars/sec
  resultLength: number
  contextPressure: number  // 0..1
  isError: boolean
  isApproval: boolean
  consecutiveRoutine: number
}

export interface FluencyPolicy {
  visibility: FluencyVisibility
  foldRoutine: boolean
  coalesceMs: number
  staleMessage?: string
}

export function computeFluencyPolicy(signals: FluencySignals): FluencyPolicy {
  // Errors and approvals always surface
  if (signals.isError) {
    return { visibility: 'inspect', foldRoutine: false, coalesceMs: 0 }
  }
  if (signals.isApproval) {
    return { visibility: 'inspect', foldRoutine: false, coalesceMs: 0 }
  }

  // High context pressure → stress mode with coalescing
  if (signals.contextPressure >= 0.8) {
    return { visibility: 'stress', foldRoutine: true, coalesceMs: 1000 + Math.round(signals.contextPressure * 2000) }
  }

  // Silent too long → stale inspection
  if (signals.silentMs >= 10_000) {
    return {
      visibility: 'inspect',
      foldRoutine: false,
      coalesceMs: 0,
      staleMessage: signals.silentMs >= 30_000
        ? `No activity for ${Math.round(signals.silentMs / 1000)}s — may be stuck`
        : `Waiting ${Math.round(signals.silentMs / 1000)}s…`,
    }
  }

  // Many consecutive routine events → quiet mode
  if (signals.consecutiveRoutine >= 4) {
    return { visibility: 'quiet', foldRoutine: true, coalesceMs: 500 }
  }

  return { visibility: 'normal', foldRoutine: false, coalesceMs: 0 }
}

// --- Stage Health ---

export interface StageSnapshot {
  phase: ActivityPhase
  startedAt: number
  lastEventAt: number
}

export interface StageHealth {
  silentMs: number
  durationMs: number
  isStale: boolean
  healthLabel: string
}

const STALE_THRESHOLDS: Partial<Record<ActivityPhase, number>> = {
  thinking: 60_000,
  streaming: 15_000,
  tool: 30_000,
  mcp: 30_000,
  compacting: 120_000,
  analyzing: 30_000,
}

export function computeStageHealth(snapshot: StageSnapshot, now: number): StageHealth {
  const silentMs = now - snapshot.lastEventAt
  const durationMs = now - snapshot.startedAt
  const threshold = STALE_THRESHOLDS[snapshot.phase] ?? 30_000
  const isStale = silentMs >= threshold

  let healthLabel: string
  if (isStale) {
    healthLabel = `stale (${Math.round(silentMs / 1000)}s silent)`
  } else if (silentMs >= threshold * 0.6) {
    healthLabel = 'slow'
  } else {
    healthLabel = 'healthy'
  }

  return { silentMs, durationMs, isStale, healthLabel }
}

// --- Routine Counter ---

export class RoutineCounter {
  private _count = 0

  get count(): number { return this._count }

  record(isRoutine: boolean): void {
    this._count = isRoutine ? this._count + 1 : 0
  }

  reset(): void { this._count = 0 }

  get shouldFold(): boolean { return this._count >= 4 }
}
