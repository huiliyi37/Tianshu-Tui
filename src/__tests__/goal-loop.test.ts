import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGoalLoop, type GoalLoopConfig } from '../goal-loop.js'
import type { AgentCallbacks } from '../agent/loop.js'

describe('Goal Loop', () => {
  it('exits when goal is achieved (agent returns done)', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'fix the bug',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          runCount++
          callbacks.onTextDelta('Fixed the bug. All tests pass.')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, runCount)
        },
      }),
      checkGoalAchieved: (text: string) => text.includes('All tests pass'),
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, true)
    assert.equal(result.iterations, 1)
    assert.equal(result.exitReason, 'goal_achieved')
  })

  it('exits when budget exhausted', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'impossible task',
      budget: 3,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          runCount++
          callbacks.onTextDelta('Still working...')
          callbacks.onTurnComplete({ input_tokens: 1000, output_tokens: 500 }, runCount)
        },
      }),
      checkGoalAchieved: () => false,
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, false)
    assert.equal(result.iterations, 3)
    assert.equal(result.exitReason, 'budget_exhausted')
  })

  it('exits on consecutive failures', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'fix it',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          runCount++
          callbacks.onError(new Error('API timeout'))
        },
      }),
      checkGoalAchieved: () => false,
    }
    const result = await runGoalLoop(config)
    assert.equal(result.achieved, false)
    assert.equal(result.exitReason, 'consecutive_failures')
    assert.ok(result.iterations <= 3)
  })
})
