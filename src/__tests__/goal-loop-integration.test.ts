import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGoalLoop } from '../goal-loop.js'
import type { AgentCallbacks } from '../agent/loop-types.js'

describe('Goal Loop integration', () => {
  it('multi-iteration convergence to goal achieved', async () => {
    let iteration = 0
    const result = await runGoalLoop({
      goal: 'count to 3',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          iteration++
          callbacks.onTextDelta(iteration >= 3 ? 'Goal achieved! Counted to 3.' : `Count: ${iteration}`)
          callbacks.onTurnComplete({ input_tokens: 50, output_tokens: 20 }, iteration)
       },
     }),
      checkGoalAchieved: (text: string) => text.includes('Goal achieved'),
   })
    assert.equal(result.achieved, true)
    assert.equal(result.iterations, 3)
    assert.equal(result.exitReason, 'goal_achieved')
 })

  it('respects budget even when making progress', async () => {
    const result = await runGoalLoop({
      goal: 'infinite task',
      budget: 5,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Making progress...')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1)
       },
     }),
      checkGoalAchieved: () => false,
   })
    assert.equal(result.achieved, false)
    assert.equal(result.iterations, 5)
    assert.equal(result.exitReason, 'budget_exhausted')
 })

  it('detects goal from tool_result context including error-tagged results', async () => {
    const result = await runGoalLoop({
      goal: 'make tests pass',
      budget: 5,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onToolResult('t1', 'run_tests', 'Tests: 50 pass, 0 fail', false)
          callbacks.onToolResult('t2', 'bash', 'some command failed', true)
          callbacks.onTextDelta('All tests are passing now.')
          callbacks.onTurnComplete({ input_tokens: 200, output_tokens: 100 }, 1)
       },
     }),
      checkGoalAchieved: (text: string) => text.includes('Tests:') && text.includes('pass'),
   })
    // Tool errors are included in context for goal check but don't trigger circuit breaker
    assert.equal(result.achieved, true)
    assert.equal(result.exitReason, 'goal_achieved')
 })

  it('consecutive errors trigger circuit breaker', async () => {
    let calls = 0
    const result = await runGoalLoop({
      goal: 'fix',
      budget: 10,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          calls++
          callbacks.onError(new Error('API error'))
       },
     }),
      checkGoalAchieved: () => false,
   })
    assert.equal(result.achieved, false)
    assert.equal(result.exitReason, 'consecutive_failures')
    assert.equal(calls, 3)
 })
})
