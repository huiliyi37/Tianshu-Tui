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
  staleLevel?: 'info' | 'warn' | 'action'
}

const HIGH_VOLUME_RESULT_LENGTH = 50_000
const HIGH_OUTPUT_RATE = 50_000

// Phase-aware stale tiers: [info threshold, warn threshold, actionable threshold]
const PHASE_STALE_TIERS: Record<ActivityPhase, [number, number, number]> = {
  thinking:   [30_000,  90_000, 180_000],
  streaming:  [15_000,  60_000, 120_000],
  tool:       [45_000,  90_000, 180_000],
  mcp:        [15_000,  30_000,  60_000],
  compacting: [30_000, 120_000, 240_000],
  analyzing:  [15_000,  60_000, 120_000],
  waiting:    [15_000,  60_000, 120_000],
  idle:       [15_000,  60_000, 120_000],
  preflight:  [15_000,  60_000, 120_000],
}

function getPhaseStaleMessage(phase: ActivityPhase, silentMs: number): { message: string; level: 'info' | 'warn' | 'action' } | null {
  const tiers = PHASE_STALE_TIERS[phase] ?? PHASE_STALE_TIERS.streaming
  const [info, warn, action] = tiers
  const sec = Math.round(silentMs / 1000)
  const min = Math.round(silentMs / 60_000)

  if (silentMs >= action) {
    if (phase === 'thinking') return { message: `Long think — Ctrl+C to stop (${min}m)`, level: 'action' }
    if (phase === 'tool') return { message: `Tool may be stuck — Ctrl+C (${min}m)`, level: 'action' }
    if (phase === 'compacting') return { message: `Compaction very slow (${min}m)`, level: 'action' }
    return { message: `No response — Ctrl+C to interrupt (${min}m)`, level: 'action' }
  }
  if (silentMs >= warn) {
    if (phase === 'thinking') return { message: `Collecting context... ${min}m`, level: 'warn' }
    if (phase === 'tool') return { message: `Tool running long... ${min}m`, level: 'warn' }
    if (phase === 'compacting') return { message: `Compacting... ${min}m`, level: 'warn' }
    return { message: `Still waiting... ${min}m`, level: 'warn' }
  }
  if (silentMs >= info) {
    if (phase === 'thinking') return { message: `Thinking deeply... ${sec}s`, level: 'info' }
    if (phase === 'tool') return { message: `Executing tools... ${sec}s`, level: 'info' }
    if (phase === 'compacting') return { message: `Compacting... ${sec}s`, level: 'info' }
    return { message: `Waiting for response... ${sec}s`, level: 'info' }
  }
  return null
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

  // Silent too long → stale inspection (phase-aware thresholds)
  if (signals.silentMs >= 15_000) {
    const stale = getPhaseStaleMessage(signals.phase, signals.silentMs)
    if (stale) {
      return {
        visibility: 'inspect',
        foldRoutine: false,
        coalesceMs: 0,
        staleMessage: stale.message,
        staleLevel: stale.level,
      }
    }
  }

  if (signals.resultLength >= HIGH_VOLUME_RESULT_LENGTH || signals.outputRate >= HIGH_OUTPUT_RATE) {
    return { visibility: 'inspect', foldRoutine: true, coalesceMs: 1000 }
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
  thinking: 90_000,
  streaming: 20_000,
  tool: 60_000,
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
