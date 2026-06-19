import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { GoalTracker } from '../goal-tracker.js'
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
