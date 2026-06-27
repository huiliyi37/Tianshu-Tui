import type { GoalTracker } from './goal-tracker.js'
import type { GoalJudgeDeps } from './goal-judge.js'
import { runGoalJudge } from './goal-judge.js'
import { rejectOnAbort } from './turn-boundary-abort.js'
import { saveGoalState } from './goal-persist.js'
import { getSessionDir } from './session-persist.js'
import type { CompleteTurnParams } from './turn-orchestrator.js'
import type { AgentCallbacks } from './loop-types.js'
import type { TelemetryRecord } from './telemetry-writer.js'

// ── Types ──

export interface GoalContinuationDeps {
  getGoalTracker: () => GoalTracker | null
  getGoalJudgeDeps?: () => GoalJudgeDeps | undefined
  getGoalJudgeEvidence?: () => { text: string; modifiedFiles: string[] }
  getStreamedText: () => string
  getEstimatedTokens: () => number
  getSessionId: () => string | undefined
  getCwd: () => string
  appendSystemReminder: (content: string) => void
  completeTurn: (params: CompleteTurnParams) => Promise<void>
  writeTelemetry: (entry: TelemetryRecord) => void
  flushMeridianTurn: () => void
}

export type GoalCheckResult =
  | { kind: 'continue' }
  | { kind: 'accept' }
  | { kind: 'finalize' }

export interface GoalCheckParams {
  streamedText: string
  estimatedTokens: number
  isAborted: boolean
  turn: number
  callbacks: AgentCallbacks
  signal: AbortSignal
}

// ── Controller ──

export class GoalContinuationController {
  constructor(private deps: GoalContinuationDeps) {}

  /**
   * Run the full goal-continuation check for this turn.
   *
   * Returns:
   * - 'continue' — goal still active, orchestrator should re-enter the loop.
   *   completeTurn(isFinal:false) + appendSystemReminder already called internally.
   * - 'accept' — goal achieved and accepted. appendSystemReminder already called.
   *   Orchestrator should fall through to final completion.
   * - 'finalize' — no active goal tracker, or tracker deactivated. Orchestrator
   *   should fall through to phantom check / final completion.
   */
  async handleGoalCheck(params: GoalCheckParams): Promise<GoalCheckResult> {
    const tracker = this.deps.getGoalTracker()
    if (!tracker?.isActive()) return { kind: 'finalize' }

    const signal = params.signal
    const goalResult = tracker.check(
      params.streamedText,
      params.estimatedTokens,
      params.isAborted,
    )

    if (goalResult.shouldContinue) {
      tracker.advanceIteration()
      return this.finishContinuation(tracker, signal, params, null)
    }

    if (goalResult.reason === 'achieved') {
      const decision = await this.judgeGoalCompletion(tracker, signal)
      if (decision.action === 'continue') {
        tracker.advanceIteration()
        return this.finishContinuation(tracker, signal, params, decision.reminder)
      } else {
        this.deps.appendSystemReminder(decision.reminder)
        tracker.deactivate('achieved')
        this.persistGoalState(tracker)
        this.deps.flushMeridianTurn()
        return { kind: 'accept' }
      }
    }

    // budget/context/wall-clock/cancelled: deactivate
    const deactivationReason = goalResult.reason === 'budget_exhausted' ? 'budget_exhausted'
      : goalResult.reason === 'context_limit' ? 'context_limit'
      : goalResult.reason === 'wall_clock_exhausted' ? 'budget_exhausted'
      : 'cancelled'
    tracker.deactivate(deactivationReason)
    this.persistGoalState(tracker)
    this.deps.flushMeridianTurn()
    return { kind: 'finalize' }
  }

  private persistGoalState(tracker: GoalTracker): void {
    const sid = this.deps.getSessionId()
    if (sid) {
      try { saveGoalState(getSessionDir(this.deps.getCwd()), sid, tracker) } catch { /* best-effort */ }
    }
  }

  private async finishContinuation(
    tracker: GoalTracker,
    signal: AbortSignal,
    params: GoalCheckParams,
    judgeReminder: string | null,
  ): Promise<GoalCheckResult> {
    this.persistGoalState(tracker)
    this.deps.flushMeridianTurn()

    await rejectOnAbort(
      this.deps.completeTurn({ turn: params.turn, isFinal: false, callbacks: params.callbacks }),
      signal,
      'goal-continue-complete',
    )

    if (judgeReminder) {
      this.deps.appendSystemReminder(judgeReminder)
    } else {
      const iter = tracker.getIteration()
      const maxIter = tracker.getMaxIterations()
      const wallElapsed = Math.round(tracker.getWallClockElapsedMs() / 1000)
      const wallBudget = tracker.getWallClockBudgetMs()
      const wallInfo = wallBudget
        ? ` ⏱${wallElapsed}s/${Math.round(wallBudget / 1000)}s`
        : ` ⏱${wallElapsed}s`
      this.deps.appendSystemReminder(
        `[GOAL CONTINUATION ${iter}/${maxIter}${wallInfo}] 目标尚未达成。继续执行。\n` +
        `目标: ${tracker.getGoal()}\n` +
        `上轮输出摘要: ${this.deps.getStreamedText().slice(-500)}\n` +
        `完成后输出 "GOAL ACHIEVED" 声明完成。遇到无法解决的阻塞时输出 "GOAL BLOCKED"。`
      )
    }
    return { kind: 'continue' }
  }

  /**
   * Gate a self-declared goal completion through the independent judge.
   * Extracted verbatim from TurnOrchestrator.judgeGoalCompletion.
   */
  async judgeGoalCompletion(
    tracker: GoalTracker,
    signal: AbortSignal | undefined,
  ): Promise<{ action: 'accept' | 'continue'; reminder: string }> {
    const achievedReminder = (suffix = ''): string =>
      `[GOAL] 目标已达成（${tracker.getIteration()} 次迭代）。Goal tracker 已关闭。${suffix}\n` +
      `运行 deliver_task commit=true 提交最终改动，系统将自动触发 L3 审查。`

    const judgeDeps = this.deps.getGoalJudgeDeps?.()
    if (!judgeDeps) {
      return { action: 'accept', reminder: achievedReminder() }
    }

    tracker.recordJudgeRun()
    const evidence = this.deps.getGoalJudgeEvidence?.() ?? { text: '', modifiedFiles: [] }
    const verdict = await rejectOnAbort(
      runGoalJudge(judgeDeps, {
        objective: tracker.getGoal(),
        criteria: tracker.getSuccessCriteria(),
        evidence: evidence.text,
        finalClaim: this.deps.getStreamedText(),
        scopeFiles: evidence.modifiedFiles,
        signal,
      }),
      signal!,
      'goal-judge',
    )

    let action: 'accept' | 'continue'
    let reminder: string
    let acceptedUnverified = false

    if (verdict.overall === 'verified') {
      action = 'accept'
      reminder = achievedReminder(' Judge 已独立核验全部验收项。')
    } else if (verdict.overall === 'rejected') {
      if (tracker.getJudgeRuns() < tracker.getMaxJudgeRuns()) {
        const unmet = verdict.criteria
          .filter(c => c.met === false)
          .map(c => `- ${c.criterion}${c.evidence ? `（证据: ${c.evidence}）` : ''}`)
        const iter = tracker.getIteration()
        const maxIter = tracker.getMaxIterations()
        action = 'continue'
        reminder =
          `[GOAL JUDGE 驳回 ${tracker.getJudgeRuns()}/${tracker.getMaxJudgeRuns()}] 完成声明未通过独立核验，继续执行。\n` +
          `目标: ${tracker.getGoal()}\n` +
          `未达成的验收项:\n${unmet.length > 0 ? unmet.join('\n') : `- ${verdict.summary || '判定未达成'}`}\n` +
          `请修复后再次输出 "GOAL ACHIEVED"。（迭代 ${iter}/${maxIter}）`
      } else {
        action = 'accept'
        reminder = achievedReminder(
          ` ⚠️ Judge 仍判定未完全达成（已达 ${tracker.getMaxJudgeRuns()} 次核验上限，接受为未完全验证）。残留: ${verdict.summary || '见上轮判定'}。`,
        )
        acceptedUnverified = true
      }
    } else {
      action = 'accept'
      reminder = achievedReminder(` ⚠️ Judge 未能独立验证（${verdict.summary || '原因未知'}），接受为未验证完成。`)
      acceptedUnverified = true
    }

    if (action === 'accept') {
      const criteriaMet = verdict.criteria.filter(c => c.met === true).length
      const criteriaUnmet = verdict.criteria.filter(c => c.met === false).length
      tracker.setLastVerdict({
        overall: verdict.overall,
        criteriaMet,
        criteriaUnmet,
        criteriaTotal: verdict.criteria.length,
        summary: verdict.summary,
      })
      this.deps.writeTelemetry({
        kind: 'goal_judge_verdict',
        overall: verdict.overall,
        judgeRuns: tracker.getJudgeRuns(),
        maxJudgeRuns: tracker.getMaxJudgeRuns(),
        criteriaTotal: verdict.criteria.length,
        criteriaMet,
        criteriaUnmet,
        acceptedUnverified,
        iteration: tracker.getIteration(),
      })
    }

    return { action, reminder }
  }
}
