import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GoalTracker, buildGoalModePrompt } from '../goal-tracker.js'
import type { GoalTrackerConfig } from '../goal-tracker.js'
import type { GoalStateRecord } from '../goal-state.js'

function makeConfig(overrides?: Partial<GoalTrackerConfig>): GoalTrackerConfig {
  return {
    goal: 'Test goal',
    maxIterations: 10,
    contextWindow: 128000,
    ...overrides,
  }
}

describe('GoalTracker', () => {
  it('isActive returns true after construction', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.isActive(), true)
  })

  it('isActive returns false after deactivate', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate()
    assert.equal(t.isActive(), false)
  })

  it('check returns no_goal when inactive', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate()
    const result = t.check('some text', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'no_goal')
  })

  it('check returns achieved when streamedText contains GOAL ACHIEVED', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('task complete GOAL ACHIEVED', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'achieved')
  })

  it('check returns achieved for Chinese 目标完成', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('所有 bug 已修复，目标完成。', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'achieved')
  })

  it('check returns achieved for Chinese 任务已完成', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('代码已提交，任务已完成。', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'achieved')
  })

  it('check returns achieved for Chinese 目标已完成', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('测试全部通过，目标已完成。', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'achieved')
  })

  it('check returns achieved for case-insensitive goal achieved', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('goal ACHieVed successfully', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'achieved')
  })

  it('check returns budget_exhausted when iteration >= maxIterations', () => {
    const t = new GoalTracker(makeConfig({ maxIterations: 3 }))
    // advance 3 times to hit the limit
    t.advanceIteration()
    t.advanceIteration()
    t.advanceIteration()
    const result = t.check('work done', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'budget_exhausted')
  })

  it('check returns context_limit when estTokens > 95% of contextWindow', () => {
    const t = new GoalTracker(makeConfig({ contextWindow: 100000 }))
    const result = t.check('text', 96000, false) // 96% > 95%
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'context_limit')
  })

  it('check returns context_limit when estTokens equals exactly 95%', () => {
    const t = new GoalTracker(makeConfig({ contextWindow: 100000 }))
    // 95% exactly — not over, should continue
    const result = t.check('text', 95000, false)
    assert.equal(result.shouldContinue, true)
    assert.equal(result.reason, 'continue')
  })

  it('check returns continue when goal not yet achieved', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('working on it...', 5000, false)
    assert.equal(result.shouldContinue, true)
    assert.equal(result.reason, 'continue')
  })

  it('check returns no_goal when aborted is true', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('text', 1000, true)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'no_goal')
  })

  it('advanceIteration increments the counter', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.getIteration(), 0)
    t.advanceIteration()
    assert.equal(t.getIteration(), 1)
    t.advanceIteration()
    assert.equal(t.getIteration(), 2)
  })

  it('deactivate sets active to false', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.isActive(), true)
    t.deactivate()
    assert.equal(t.isActive(), false)
  })

  it('getGoal returns the goal text', () => {
    const t = new GoalTracker(makeConfig({ goal: 'fix all bugs' }))
    assert.equal(t.getGoal(), 'fix all bugs')
  })

  it('getMaxIterations returns the configured limit', () => {
    const t = new GoalTracker(makeConfig({ maxIterations: 42 }))
    assert.equal(t.getMaxIterations(), 42)
  })

  it('GOAL ACHIEVED keyword is not matched mid-word', () => {
    const t = new GoalTracker(makeConfig())
    // "GOAL_ACHIEVED" (underscore, no space) should NOT trigger — it's a different token
    const result = t.check('PRE_GOAL_ACHIEVED_CHECK done', 1000, false)
    assert.equal(result.shouldContinue, true)
    assert.equal(result.reason, 'continue')
  })
})

describe('GoalTracker judge fields', () => {
  it('defaults to empty criteria and maxJudgeRuns=3', () => {
    const t = new GoalTracker(makeConfig())
    assert.deepEqual(t.getSuccessCriteria(), [])
    assert.equal(t.getMaxJudgeRuns(), 3)
    assert.equal(t.getJudgeRuns(), 0)
  })

  it('accepts criteria and maxJudgeRuns from config', () => {
    const t = new GoalTracker(makeConfig({ successCriteria: ['a', 'b'], maxJudgeRuns: 5 }))
    assert.deepEqual(t.getSuccessCriteria(), ['a', 'b'])
    assert.equal(t.getMaxJudgeRuns(), 5)
  })

  it('setSuccessCriteria replaces criteria with a defensive copy', () => {
    const t = new GoalTracker(makeConfig())
    const src = ['c1']
    t.setSuccessCriteria(src)
    src.push('mutated')
    assert.deepEqual(t.getSuccessCriteria(), ['c1'])
  })

  it('getSuccessCriteria returns a copy (caller cannot mutate internal state)', () => {
    const t = new GoalTracker(makeConfig({ successCriteria: ['x'] }))
    t.getSuccessCriteria().push('y')
    assert.deepEqual(t.getSuccessCriteria(), ['x'])
  })

  it('recordJudgeRun increments toward the cap', () => {
    const t = new GoalTracker(makeConfig({ maxJudgeRuns: 2 }))
    assert.equal(t.getJudgeRuns(), 0)
    t.recordJudgeRun()
    assert.equal(t.getJudgeRuns(), 1)
    t.recordJudgeRun()
    assert.equal(t.getJudgeRuns(), 2)
    assert.equal(t.getJudgeRuns() >= t.getMaxJudgeRuns(), true)
  })

  it('check() regex behavior is unchanged by judge fields', () => {
    const t = new GoalTracker(makeConfig({ successCriteria: ['a'], maxJudgeRuns: 1 }))
    assert.equal(t.check('GOAL ACHIEVED', 1000, false).reason, 'achieved')
    assert.equal(t.check('still working', 1000, false).reason, 'continue')
  })

  it('setLastVerdict / getLastVerdict round-trips', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.getLastVerdict(), null)
    t.setLastVerdict({ overall: 'verified', criteriaMet: 3, criteriaUnmet: 0, criteriaTotal: 3, summary: 'all good' })
    const v = t.getLastVerdict()
    assert.equal(v?.overall, 'verified')
    assert.equal(v?.criteriaMet, 3)
    assert.equal(v?.summary, 'all good')
  })

  it('getLastVerdict returns null when no verdict was set', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.getLastVerdict(), null)
  })
})

describe('buildGoalModePrompt', () => {
  it('embeds the goal text', () => {
    assert.ok(buildGoalModePrompt('make all tests pass').includes('make all tests pass'))
  })

  it('carries the [GOAL MODE] marker', () => {
    assert.ok(buildGoalModePrompt('x').startsWith('[GOAL MODE]'))
  })

  it('instructs the completion marker that GoalTracker.check detects', () => {
    // The wording here is the single source of truth shared by TUI /goal and
    // headless --goal; the marker MUST stay detectable by check().
    const prompt = buildGoalModePrompt('refactor auth')
    assert.ok(prompt.includes('GOAL ACHIEVED'))
    const t = new GoalTracker(makeConfig())
    // A model that follows the prompt and emits the marker must be detected.
    const result = t.check('All done.\nGOAL ACHIEVED', 1000, false)
    assert.equal(result.reason, 'achieved')
  })
})

describe('GoalTracker 4-state FSM', () => {
  it('getStatus returns active after construction', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.getStatus(), 'active')
  })

  it('getGoalId returns a non-empty string', () => {
    const t = new GoalTracker(makeConfig())
    assert.ok(t.getGoalId().length > 0)
  })

  it('getGoalId returns unique ids per tracker', () => {
    const t1 = new GoalTracker(makeConfig())
    const t2 = new GoalTracker(makeConfig())
    assert.notEqual(t1.getGoalId(), t2.getGoalId())
  })

  it('pause transitions active → paused', () => {
    const t = new GoalTracker(makeConfig())
    t.pause('user requested', 'user')
    assert.equal(t.getStatus(), 'paused')
    assert.equal(t.isActive(), false)
    assert.equal(t.getTerminalReason(), 'user requested')
  })

  it('markBlocked transitions active → blocked', () => {
    const t = new GoalTracker(makeConfig())
    t.markBlocked('missing dependency', 'model')
    assert.equal(t.getStatus(), 'blocked')
    assert.equal(t.isActive(), false)
    assert.equal(t.getTerminalReason(), 'missing dependency')
  })

  it('markComplete transitions active → complete', () => {
    const t = new GoalTracker(makeConfig())
    t.markComplete('model')
    assert.equal(t.getStatus(), 'complete')
    assert.equal(t.isActive(), false)
    assert.equal(t.isGoalAchieved(), true)
  })

  it('resume transitions paused → active', () => {
    const t = new GoalTracker(makeConfig())
    t.pause()
    assert.equal(t.getStatus(), 'paused')
    t.resume('user')
    assert.equal(t.getStatus(), 'active')
    assert.equal(t.isActive(), true)
    assert.equal(t.getTerminalReason(), null)
  })

  it('resume transitions blocked → active', () => {
    const t = new GoalTracker(makeConfig())
    t.markBlocked('temp issue')
    t.resume()
    assert.equal(t.getStatus(), 'active')
  })

  it('cancel sets terminal state', () => {
    const t = new GoalTracker(makeConfig())
    t.cancel()
    assert.equal(t.getStatus(), 'complete')
    assert.equal(t.isActive(), false)
  })

  it('throws on invalid transition (complete → active)', () => {
    const t = new GoalTracker(makeConfig())
    t.markComplete()
    assert.throws(() => t.resume(), /Invalid goal transition/)
  })

  it('throws on invalid transition (paused → blocked)', () => {
    const t = new GoalTracker(makeConfig())
    t.pause()
    assert.throws(() => t.markBlocked('x'), /Invalid goal transition/)
  })

  it('throws on resume when already active', () => {
    const t = new GoalTracker(makeConfig())
    assert.throws(() => t.resume(), /Invalid goal transition/)
  })

  it('check returns no_goal when paused', () => {
    const t = new GoalTracker(makeConfig())
    t.pause()
    const result = t.check('GOAL ACHIEVED', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'no_goal')
  })

  it('check returns no_goal when blocked', () => {
    const t = new GoalTracker(makeConfig())
    t.markBlocked('x')
    const result = t.check('GOAL ACHIEVED', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'no_goal')
  })
})

describe('GoalTracker wall-clock budget', () => {
  it('getWallClockBudgetMs returns configured budget', () => {
    const t = new GoalTracker(makeConfig({ wallClockMs: 60000 }))
    assert.equal(t.getWallClockBudgetMs(), 60000)
  })

  it('getWallClockBudgetMs returns undefined when not set', () => {
    const t = new GoalTracker(makeConfig())
    assert.equal(t.getWallClockBudgetMs(), undefined)
  })

  it('getWallClockElapsedMs increases with time when active', () => {
    const t = new GoalTracker(makeConfig())
    const before = t.getWallClockElapsedMs()
    // Busy-wait a tiny bit to ensure Date.now() advances
    const start = Date.now()
    while (Date.now() - start < 2) { /* spin */ }
    const after = t.getWallClockElapsedMs()
    assert.ok(after >= before, 'wall clock should not decrease')
  })

  it('getWallClockElapsedMs freezes when paused', () => {
    const t = new GoalTracker(makeConfig())
    t.pause()
    const before = t.getWallClockElapsedMs()
    const start = Date.now()
    while (Date.now() - start < 2) { /* spin */ }
    const after = t.getWallClockElapsedMs()
    assert.equal(after, before, 'wall clock should be frozen when paused')
  })

  it('check returns wall_clock_exhausted when budget exceeded', () => {
    const t = new GoalTracker(makeConfig({ wallClockMs: 1 }))
    // Budget is 1ms — by the time check runs it's almost certainly exceeded
    const start = Date.now()
    while (Date.now() - start < 5) { /* spin to exceed 1ms budget */ }
    const result = t.check('working', 1000, false)
    assert.equal(result.shouldContinue, false)
    assert.equal(result.reason, 'wall_clock_exhausted')
  })

  it('check does not return wall_clock_exhausted when no budget set', () => {
    const t = new GoalTracker(makeConfig())
    const result = t.check('working', 1000, false)
    assert.equal(result.shouldContinue, true)
    assert.equal(result.reason, 'continue')
  })
})

describe('GoalTracker toRecord / fromRecord', () => {
  it('toRecord serializes active tracker', () => {
    const t = new GoalTracker(makeConfig({ wallClockMs: 60000 }))
    t.advanceIteration()
    const record = t.toRecord()
    assert.equal(record.status, 'active')
    assert.equal(record.objective, 'Test goal')
    assert.equal(record.iterationsUsed, 1)
    assert.equal(record.budgetLimits.maxIterations, 10)
    assert.equal(record.budgetLimits.contextWindow, 128000)
    assert.equal(record.budgetLimits.wallClockMs, 60000)
    assert.ok(record.savedAt > 0)
  })

  it('toRecord serializes complete tracker with terminalReason', () => {
    const t = new GoalTracker(makeConfig())
    t.markComplete('model')
    const record = t.toRecord()
    assert.equal(record.status, 'complete')
    assert.equal(record.terminalReason, 'Goal achieved')
  })

  it('toRecord serializes success criteria as completionCriterion', () => {
    const t = new GoalTracker(makeConfig({ successCriteria: ['a', 'b'] }))
    const record = t.toRecord()
    assert.equal(record.completionCriterion, 'a\nb')
  })

  it('fromRecord restores a paused tracker', () => {
    const t = new GoalTracker(makeConfig({ wallClockMs: 60000 }))
    t.advanceIteration()
    t.advanceIteration()
    t.pause('test pause')
    const record = t.toRecord()

    const restored = GoalTracker.fromRecord(record)
    assert.equal(restored.getStatus(), 'paused')
    assert.equal(restored.getGoal(), 'Test goal')
    assert.equal(restored.getIteration(), 2)
    assert.equal(restored.getWallClockBudgetMs(), 60000)
  })

  it('fromRecord normalizes active → paused (normalizeAfterResume)', () => {
    const t = new GoalTracker(makeConfig())
    t.advanceIteration()
    const record = t.toRecord()
    assert.equal(record.status, 'active')

    const restored = GoalTracker.fromRecord(record)
    assert.equal(restored.getStatus(), 'paused')
    assert.equal(restored.getTerminalReason(), 'Paused after session resume')
  })

  it('fromRecord preserves goalId', () => {
    const t = new GoalTracker(makeConfig())
    const record = t.toRecord()
    const restored = GoalTracker.fromRecord(record)
    assert.equal(restored.getGoalId(), t.getGoalId())
  })

  it('fromRecord restores wallClockAccumMs', () => {
    const t = new GoalTracker(makeConfig())
    t.pause()  // fold current interval into accum
    const record = t.toRecord()
    const restored = GoalTracker.fromRecord(record)
    // After restore, wallClockElapsedMs should equal the accumulated value
    // (restored tracker is paused, so no active interval)
    assert.equal(restored.getWallClockElapsedMs(), record.wallClockAccumMs)
  })

  it('fromRecord restores successCriteria from completionCriterion', () => {
    const record: GoalStateRecord = {
      goalId: 'test-id',
      objective: 'Test',
      status: 'paused',
      iterationsUsed: 0,
      wallClockAccumMs: 0,
      budgetLimits: { maxIterations: 10, contextWindow: 128000 },
      completionCriterion: 'criterion 1\ncriterion 2',
      savedAt: Date.now(),
    }
    const restored = GoalTracker.fromRecord(record)
    assert.deepEqual(restored.getSuccessCriteria(), ['criterion 1', 'criterion 2'])
  })

  it('round-trip: toRecord → fromRecord preserves core fields', () => {
    const t = new GoalTracker(makeConfig({ successCriteria: ['x'], wallClockMs: 30000 }))
    t.advanceIteration()
    t.advanceIteration()
    t.pause('reason')
    const record = t.toRecord()
    const restored = GoalTracker.fromRecord(record)
    assert.equal(restored.getGoal(), t.getGoal())
    assert.equal(restored.getIteration(), t.getIteration())
    assert.equal(restored.getStatus(), t.getStatus())
    assert.equal(restored.getWallClockBudgetMs(), 30000)
    assert.deepEqual(restored.getSuccessCriteria(), ['x'])
  })
})

describe('GoalTracker deactivate backward compat', () => {
  it('deactivate(achieved) sets status to complete', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate('achieved')
    assert.equal(t.getStatus(), 'complete')
    assert.equal(t.isGoalAchieved(), true)
  })

  it('deactivate(budget_exhausted) sets status to blocked', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate('budget_exhausted')
    assert.equal(t.getStatus(), 'blocked')
  })

  it('deactivate(context_limit) sets status to paused', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate('context_limit')
    assert.equal(t.getStatus(), 'paused')
  })

  it('deactivate(cancelled) sets status to complete', () => {
    const t = new GoalTracker(makeConfig())
    t.deactivate('cancelled')
    assert.equal(t.getStatus(), 'complete')
  })
})
