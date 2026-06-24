import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GoalTracker, buildGoalModePrompt } from '../goal-tracker.js'
import type { GoalTrackerConfig } from '../goal-tracker.js'

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
