export interface GoalTrackerConfig {
  goal: string
  maxIterations: number
  contextWindow: number
}

export interface GoalCheckResult {
  shouldContinue: boolean
  reason: 'achieved' | 'budget_exhausted' | 'context_limit' | 'continue' | 'no_goal'
  iteration: number
}

export class GoalTracker {
  private _active = false
  private _iteration = 0
  private readonly _goal: string
  private readonly _maxIterations: number
  private readonly _contextWindow: number

  constructor(config: GoalTrackerConfig) {
    this._goal = config.goal
    this._maxIterations = config.maxIterations
    this._contextWindow = config.contextWindow
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

  /** Check if the goal is achieved or limits are hit. Does NOT mutate state. */
  check(streamedText: string, estimatedTokens: number, aborted: boolean): GoalCheckResult {
    if (!this._active) {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (aborted) {
      return { shouldContinue: false, reason: 'no_goal', iteration: this._iteration }
    }

    if (/GOAL ACHIEVED/i.test(streamedText)) {
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

  /** Deactivate the tracker (goal done or cancelled). */
  deactivate(): void {
    this._active = false
  }
}
