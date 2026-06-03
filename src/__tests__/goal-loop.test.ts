import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { runGoalLoop, type GoalLoopConfig } from '../goal-loop.js'
import type { AgentCallbacks } from '../agent/loop-types.js'

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

  it('exits on consecutive API failures', async () => {
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

  it('tool errors do NOT trigger circuit breaker', async () => {
    let runCount = 0
    const config: GoalLoopConfig = {
      goal: 'fix it',
      budget: 5,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          runCount++
          // Tool fails but turn completes normally
          callbacks.onToolResult('t1', 'bash', 'Command failed with exit code 1', true)
          callbacks.onTextDelta('Retrying with different approach...')
          callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, runCount)
       },
     }),
      checkGoalAchieved: () => false,
   }
    const result = await runGoalLoop(config)
    // Tool errors should not count as consecutive failures
    assert.equal(result.achieved, false)
    assert.equal(result.exitReason, 'budget_exhausted')
    assert.equal(result.iterations, 5)
 })

  it('mix of tool errors and API errors resets correctly', async () => {
    const outcomes: Array<'tool-err' | 'api-err' | 'ok'> = ['tool-err', 'ok', 'api-err', 'tool-err', 'ok']
    let idx = 0
    const config: GoalLoopConfig = {
      goal: 'fix it',
      budget: 5,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          const outcome = outcomes[idx++] ?? 'ok'
          if (outcome === 'tool-err') {
            callbacks.onToolResult('t1', 'bash', 'failed', true)
            callbacks.onTextDelta('Tool failed, continuing...')
            callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, idx)
         } else if (outcome === 'api-err') {
            callbacks.onError(new Error('API error'))
         } else {
            callbacks.onTextDelta('Making progress...')
            callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, idx)
         }
       },
     }),
      checkGoalAchieved: () => false,
   }
    const result = await runGoalLoop(config)
    assert.equal(result.exitReason, 'budget_exhausted')
    assert.equal(result.iterations, 5)
 })

  it('writes final NDJSON event when goal achieved', async () => {
    const lines: string[] = []
    const origWrite = process.stdout.write.bind(process.stdout)
    const mockWrite = (chunk: unknown) => {
      if (typeof chunk === 'string') lines.push(chunk.trim())
      return true
   }
    process.stdout.write = mockWrite as typeof process.stdout.write

    try {
      const config: GoalLoopConfig = {
        goal: 'fix it',
        budget: 5,
        streamJson: true,
        createAgent: () => ({
          run: async (_prompt: string, callbacks: AgentCallbacks) => {
            callbacks.onTextDelta('Goal achieved!')
            callbacks.onTurnComplete({ input_tokens: 100, output_tokens: 50 }, 1)
         },
       }),
        checkGoalAchieved: () => true,
     }
      await runGoalLoop(config)

      const goalComplete = lines.find(l => l.includes('"type":"goal_complete"'))
      assert.ok(goalComplete, 'should write goal_complete NDJSON event')
      const parsed = JSON.parse(goalComplete!)
      assert.equal(parsed.achieved, true)
      assert.equal(parsed.type, 'goal_complete')
   } finally {
      process.stdout.write = origWrite
   }
 })
})
