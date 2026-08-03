import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { summarizeStreamJson } from '../executor.js'

describe('summarizeStreamJson', () => {
  it('collects agent turns, tool calls, cache rate, and cost from headless events', () => {
    const summary = summarizeStreamJson([
      JSON.stringify({ type: 'tool_use', id: 'a', name: 'read_file' }),
      JSON.stringify({ type: 'tool_use', id: 'b', name: 'grep' }),
      JSON.stringify({ type: 'turn_complete', turn: 1, usage: { inputTokens: 100, cacheReadInputTokens: 60, costUsd: 0.02 } }),
      JSON.stringify({ type: 'result', is_error: false }),
    ].join('\n'))

    assert.deepEqual(summary.metrics, {
      turns: 1,
      toolCalls: 2,
      retries: 0,
      cacheHitRate: 0.6,
      costUsd: 0.02,
    })
  })

  it('keeps parsing metrics when diagnostics add non-JSON lines', () => {
    const summary = summarizeStreamJson('provider warning\n' + JSON.stringify({ type: 'error', error: 'network unavailable' }))
    assert.equal(summary.metrics.turns, 0)
    assert.equal(summary.resultError, 'network unavailable')
  })
})
