/**
 * Goal lifecycle state machine — types and transition validation.
 *
 * Upgrades the binary active/inactive model to a 4-state FSM:
 * active → paused | blocked | complete, with resume paths back to active
 * (except complete, which is terminal).
 */

/** Goal lifecycle status — mirrors kimi-code's GoalStatus with Tianshu extensions. */
export type GoalStatus = 'active' | 'paused' | 'blocked' | 'complete'

/** Who triggered a status transition. */
export type GoalActor = 'user' | 'model' | 'runtime'

/** Budget limits for a goal. wallClockMs undefined = unlimited. */
export interface GoalBudgetLimits {
  readonly maxIterations: number
  readonly contextWindow: number
  readonly wallClockMs?: number
}

/** Serializable goal state for persistence. */
export interface GoalStateRecord {
  readonly goalId: string
  readonly objective: string
  readonly status: GoalStatus
  readonly iterationsUsed: number
  readonly wallClockAccumMs: number
  readonly budgetLimits: GoalBudgetLimits
  readonly terminalReason?: string
  readonly completionCriterion?: string
  readonly savedAt: number
}

/** Allowed outgoing transitions for each status. */
const ALLOWED_TRANSITIONS: Record<GoalStatus, readonly GoalStatus[]> = {
  active: ['paused', 'blocked', 'complete'],
  paused: ['active'],
  blocked: ['active'],
  complete: [], // terminal — no outgoing
}

/**
 * Validate that a transition from `from` to `to` is allowed by the FSM.
 * Self-loops (e.g. active→active) are never allowed.
 * `complete` has no outgoing transitions (terminal state).
 */
export function validateTransition(from: GoalStatus, to: GoalStatus): boolean {
  return ALLOWED_TRANSITIONS[from]?.includes(to) ?? false
}
