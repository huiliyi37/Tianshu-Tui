import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseCliArgs, runHeadless } from '../headless.js'
import type { AgentCallbacks } from '../agent/loop-types.js'

describe('headless CLI parsing', () => {
  it('recognizes -p prompt input', () => {
    assert.deepEqual(parseCliArgs(['-p', 'echo hello']), { headless: true, prompt: 'echo hello', json: false, streamJson: false })
  })

  it('recognizes --print prompt input with --json', () => {
    assert.deepEqual(parseCliArgs(['--print', 'summarize', '--json']), { headless: true, prompt: 'summarize', json: true, streamJson: false })
  })

  it('leaves interactive args alone', () => {
    assert.deepEqual(parseCliArgs([]), { headless: false, json: false, streamJson: false })
  })

  it('recognizes --goal with --budget', () => {
    assert.deepEqual(
      parseCliArgs(['--goal', 'make tests pass', '--budget', '20']),
      { headless: true, prompt: undefined, json: false, streamJson: false, goal: 'make tests pass', budget: 20 },
    )
  })

  it('--goal defaults budget to 100', () => {
    const result = parseCliArgs(['--goal', 'fix lint'])
    assert.equal(result.goal, 'fix lint')
    assert.equal(result.budget, 100)
    assert.equal(result.headless, true)
  })
})

describe('runHeadless', () => {
  it('returns stdout-friendly text output', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: false,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Hello')
          callbacks.onTextDelta(' world')
          callbacks.onTurnComplete({ input_tokens: 10, output_tokens: 3 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, 'Hello world')
    assert.equal(result.json, undefined)
  })

  it('returns structured JSON output in json mode', async () => {
    const result = await runHeadless({
      prompt: 'hello',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onTextDelta('Done')
          callbacks.onTurnComplete({ input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 }, 1)
        },
      }),
    })

    assert.equal(result.exitCode, 0)
    assert.equal(result.stdout, JSON.stringify(result.json))
    assert.deepEqual(result.json, {
      success: true,
      text: 'Done',
      usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 8 },
    })
  })

  it('returns structured error output when the agent fails', async () => {
    const result = await runHeadless({
      prompt: 'fail',
      json: true,
      streamJson: false,
      createAgent: () => ({
        run: async (_prompt: string, callbacks: AgentCallbacks) => {
          callbacks.onError(new Error('boom'))
        },
      }),
    })

    assert.equal(result.exitCode, 1)
    assert.deepEqual(result.json, { success: false, text: '', error: 'boom' })
  })
})
