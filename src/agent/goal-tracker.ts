export interface GoalTrackerConfig {
  goal: string
  maxIterations: number
  contextWindow: number
  /** Concrete success criteria the completion judge checks against. */
  successCriteria?: string[]
  /** Max judge runs before accepting a self-declared completion (anti judge-reject loop). Default 3. */
  maxJudgeRuns?: number
}

const DEFAULT_MAX_JUDGE_RUNS = 3

/** Lightweight verdict shape stored on the tracker for deliver_task to read.
 *  Mirrors the fields deliver_task needs — avoids importing the full type. */
export interface StoredGoalJudgeVerdict {
  overall: 'verified' | 'rejected' | 'inconclusive'
  criteriaMet: number
  criteriaUnmet: number
  criteriaTotal: number
  summary: string
}

/**
 * Build the goal-mode driver prompt. Single source of truth shared by the TUI
 * `/goal` slash command and the headless `--goal` CLI entry point, so the two
 * entry points can never drift in wording. The completion marker phrasing here
 * MUST stay in sync with GoalTracker.check()'s detection regex.
 */
export function buildGoalModePrompt(goal: string): string {
  return `[GOAL MODE] ${goal}\n\nYou are now in goal-driven mode. Work toward this goal continuously. When fully complete, output "GOAL ACHIEVED" on its own line.`
}

export interface GoalCheckResult {
  shouldContinue: boolean
  reason: 'achieved' | 'budget_exhausted' | 'context_limit' | 'continue' | 'no_goal'
  iteration: number
}

export type GoalDeactivationReason = 'achieved' | 'budget_exhausted' | 'context_limit' | 'cancelled'

export class GoalTracker {
  private _active = false
  private _iteration = 0
  private readonly _goal: string
  private readonly _maxIterations: number
  private readonly _contextWindow: number
  private _deactivationReason: GoalDeactivationReason | null = null
  private _successCriteria: string[]
  private readonly _maxJudgeRuns: number
  private _judgeRuns = 0
  private _lastVerdict: StoredGoalJudgeVerdict | null = null

  constructor(config: GoalTrackerConfig) {
    this._goal = config.goal
    this._maxIterations = config.maxIterations
    this._contextWindow = config.contextWindow
    this._successCriteria = config.successCriteria ? [...config.successCriteria] : []
    this._maxJudgeRuns = config.maxJudgeRuns ?? DEFAULT_MAX_JUDGE_RUNS
    this._active = true
  }

  isActive(): boolean {
    return this._active
  }

  getGoal(): string {
    return this._goal
  }

  getIteration(): number {
    return this._iteration
  }

  getMaxIterations(): number {
    return this._maxIterations
  }

  /** Reason the tracker was last deactivated, or null if still active. */
  getDeactivationReason(): GoalDeactivationReason | null {
    return this._deactivationReason
  }

  /** True when the goal was achieved (post-deactivation). Best-effort signal
   *  for deliver_task to auto-trigger L3 review on the final commit. */
  isGoalAchieved(): boolean {
    return this._deactivationReason === 'achieved'
  }

  /** Check if the goal is achieved or limits are hit. Does NOT mutate state. */
  check(streamedText: string, estimatedTokens: number, aborted: boolean): GoalCheckResult {
    if (!this._active) {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (aborted) {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (/GOAL ACHIEVED|目标已?完成|任务已?完成/i.test(streamedText)) {
      return { shouldContinue: false, reason: 'achieved', iteration: this._iteration }
    }

    if (this._iteration >= this._maxIterations) {
      return { shouldContinue: false, reason: 'budget_exhausted', iteration: this._iteration }
    }

    if (estimatedTokens > this._contextWindow * 0.95) {
      return { shouldContinue: false, reason: 'context_limit', iteration: this._iteration }
    }

    return { shouldContinue: true, reason: 'continue', iteration: this._iteration }
  }

  /** Advance iteration counter. Called when a continuation is decided. */
  advanceIteration(): void {
    this._iteration++
  }

  /** Success criteria the judge verifies against (may be empty → wide judgment). */
  getSuccessCriteria(): string[] {
    return [...this._successCriteria]
  }

  /** Set the criteria extracted from the goal (called once at goal start). */
  setSuccessCriteria(criteria: string[]): void {
    this._successCriteria = [...criteria]
  }

  /** Number of times the completion judge has run for this goal. */
  getJudgeRuns(): number {
    return this._judgeRuns
  }

  /** Cap on judge runs; once reached a self-declared completion is accepted unverified. */
  getMaxJudgeRuns(): number {
    return this._maxJudgeRuns
  }

  /** Record that the judge ran once (called on every judge invocation). */
  recordJudgeRun(): void {
    this._judgeRuns++
  }

  /** Store the last judge verdict for deliver_task to read as evidence. */
  setLastVerdict(v: StoredGoalJudgeVerdict): void {
    this._lastVerdict = v
  }

  /** Last judge verdict, or null if the judge hasn't run. */
  getLastVerdict(): StoredGoalJudgeVerdict | null {
    return this._lastVerdict
  }

  /** Deactivate the tracker (goal done, cancelled, or budget exhausted).
   *  reason='achieved' signals deliver_task to auto-trigger L3 final review. */
  deactivate(reason?: GoalDeactivationReason): void {
    this._active = false
    this._deactivationReason = reason ?? null
  }
}
