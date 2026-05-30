import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { OaiMessage } from '../../api/oai-types.js'

describe('buildOaiRequest performance', () => {
  function makeEngine(): PromptEngine {
    return new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
  }

  it('scales linearly with message count (not quadratically)', () => {
    const engine = makeEngine()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'start' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'tc0', type: 'function' as const, function: { name: 'read_file', arguments: '{"file_path":"src/a.ts"}' } }] },
      { role: 'tool', tool_call_id: 'tc0', content: 'x'.repeat(600) },
      { role: 'assistant', content: 'thinking about a.ts' },
    ]
    // Build up to ~150 messages
    for (let i = 1; i < 50; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `tc${i}`, type: 'function' as const, function: { name: 'grep', arguments: `{"pattern":"TODO${i}","path":"src/"}` } }] })
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, content: `src/file${i}.ts:${i}: TODO${i}\n` + 'y'.repeat(300) })
      messages.push({ role: 'assistant', content: `found TODO${i}` })
    }

    // Measure time for 50-message baseline
    const start50 = performance.now()
    engine.buildOaiRequest(messages.slice(0, 50))
    const time50 = performance.now() - start50

    // Add more messages to reach ~300
    for (let i = 50; i < 100; i++) {
      messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `tc${i}`, type: 'function' as const, function: { name: 'read_file', arguments: `{"file_path":"src/file${i}.ts"}` } }] })
      messages.push({ role: 'tool', tool_call_id: `tc${i}`, content: `content ${i} `.repeat(40) })
      messages.push({ role: 'assistant', content: `reviewed file${i}` })
    }

    const start300 = performance.now()
    engine.buildOaiRequest(messages)
    const time300 = performance.now() - start300

    // Linear scaling: time300 should be < 12x time50 (quadratic would be 36x for 6× input size)
    const ratio = time300 / Math.max(time50, 0.1)
    assert.ok(ratio < 12, `Expected linear scaling (ratio < 12), got ratio=${ratio.toFixed(1)} (50msg=${time50.toFixed(1)}ms, 300msg=${time300.toFixed(1)}ms)`)
  })
})
