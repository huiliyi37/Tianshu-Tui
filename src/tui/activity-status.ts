/**
 * Pure Activity Status Lifecycle
 *
 * Immutable state machine for tracking what the agent is doing right now.
 * Every transition returns a new object — no mutations.
 */

// ── Types ──────────────────────────────────────────────────────────────────

export type ActivityPhase =
  | 'idle'
  | 'thinking'
  | 'streaming'
  | 'analyzing'
  | 'tool'
  | 'mcp'
  | 'compacting'
  | 'preflight'

export type ActivityLifecycleStatus =
  | 'idle'
  | 'active'
  | 'stale'
  | 'completed'
  | 'failed'

export interface ActivityState {
  readonly phase: ActivityPhase
  readonly label?: string
  readonly startedAt: number
  readonly lastEventAt: number
  readonly completedAt?: number
  readonly sizeHint?: string
  readonly status: ActivityLifecycleStatus
}

// ── Transitions ────────────────────────────────────────────────────────────

export function createIdleActivity(now: number): ActivityState {
  return {
    phase: 'idle',
    startedAt: now,
    lastEventAt: now,
    status: 'idle',
  }
}

export function beginActivity(
  _state: ActivityState,
  phase: ActivityPhase,
  label: string,
  now: number,
  sizeHint?: string,
): ActivityState {
  return {
    phase,
    label,
    startedAt: now,
    lastEventAt: now,
    sizeHint,
    status: 'active',
  }
}

export function heartbeatActivity(
  state: ActivityState,
  now: number,
  options: { label?: string; sizeHint?: string } = {},
): ActivityState {
  return {
    ...state,
    label: options.label ?? state.label,
    sizeHint: options.sizeHint ?? state.sizeHint,
    lastEventAt: now,
    status: 'active',
  }
}

export function completeActivity(
  state: ActivityState,
  now: number,
  _options?: Record<string, never>,
): ActivityState {
  return {
    ...state,
    completedAt: now,
    lastEventAt: now,
    status: 'completed',
  }
}

export function failActivity(
  state: ActivityState,
  now: number,
  _options?: Record<string, never>,
): ActivityState {
  return {
    ...state,
    completedAt: now,
    lastEventAt: now,
    status: 'failed',
  }
}

export function clearActivity(
  _state: ActivityState,
  now: number,
): ActivityState {
  return {
    phase: 'idle',
    startedAt: now,
    lastEventAt: now,
    status: 'idle',
  }
}
