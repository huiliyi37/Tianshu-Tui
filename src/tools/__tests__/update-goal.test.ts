import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createUpdateGoalTool } from '../update-goal.js'
import type { ToolCallParams } from '../types.js'
import { GoalTracker } from '../../agent/goal-tracker.js'
import type { GoalTrackerConfig } from '../../agent/goal-tracker.js'

function makeTracker(overrides?: Partial<GoalTrackerConfig>): GoalTracker {
  return new GoalTracker({
    goal: 'Test goal',
    maxIterations: 10,
    contextWindow: 128000,
    ...overrides,
  })
}

function makeParams(input: Record<string, unknown>, tracker: GoalTracker | null): ToolCallParams {
  return {
    input,
    toolUseId: 'test-id',
    cwd: '/tmp',
  }
}

describe('createUpdateGoalTool', () => {
  it('returns a tool with name "update_goal"', () => {
    const tool = createUpdateGoalTool(() => null)
    assert.equal(tool.definition.name, 'update_goal')
  })

  it('is not concurrency-safe (mutates goal state)', () => {
    const tool = createUpdateGoalTool(() => null)
    assert.equal(tool.isConcurrencySafe(), false)
  })

  it('returns error when no goal tracker is available', async () => {
    const tool = createUpdateGoalTool(() => null)
    const result = await tool.execute(makeParams({ status: 'complete' }, null))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('No active goal'))
  })

  it('sets status to blocked when goal is active', async () => {
    const tracker = makeTracker()
    const tool = createUpdateGoalTool(() => tracker)
    const result = await tool.execute(makeParams({ status: 'blocked', reason: 'Missing dependency' }, tracker))
    assert.equal(result.isError, undefined)
    assert.equal(tracker.getStatus(), 'blocked')
    assert.ok(result.content.includes('blocked'))
  })

  it('sets status to complete when goal is active', async () => {
    const tracker = makeTracker()
    const tool = createUpdateGoalTool(() => tracker)
    const result = await tool.execute(makeParams({ status: 'complete' }, tracker))
    assert.equal(result.isError, undefined)
    assert.equal(tracker.getStatus(), 'complete')
  })

  it('sets status to paused when goal is active', async () => {
    const tracker = makeTracker()
    const tool = createUpdateGoalTool(() => tracker)
    const result = await tool.execute(makeParams({ status: 'paused', reason: 'Need user input' }, tracker))
    assert.equal(result.isError, undefined)
    assert.equal(tracker.getStatus(), 'paused')
  })

  it('returns error when goal is already complete', async () => {
    const tracker = makeTracker()
    tracker.markComplete('model')
    const tool = createUpdateGoalTool(() => tracker)
    const result = await tool.execute(makeParams({ status: 'paused' }, tracker))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('cannot update') || result.content.includes('not active'))
  })

  it('returns error for missing status field', async () => {
    const tracker = makeTracker()
    const tool = createUpdateGoalTool(() => tracker)
    const result = await tool.execute(makeParams({}, tracker))
    assert.equal(result.isError, true)
  })
})
