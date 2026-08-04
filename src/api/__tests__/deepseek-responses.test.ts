import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildDeepSeekResponsesBody,
  isDeepSeekResponsesEnabled,
  supportsDeepSeekResponses,
} from '../deepseek-responses.js'

describe('DeepSeek Responses dual-stack', () => {
  it('only flash is supported', () => {
    assert.equal(supportsDeepSeekResponses('deepseek-v4-flash'), true)
    assert.equal(supportsDeepSeekResponses('deepseek-v4-pro'), false)
  })

  it('enabled via protocol or env', () => {
    assert.equal(isDeepSeekResponsesEnabled('responses'), true)
    assert.equal(isDeepSeekResponsesEnabled('openai', {}), false)
    assert.equal(isDeepSeekResponsesEnabled('openai', { RIVET_DEEPSEEK_RESPONSES: '1' }), true)
  })

  it('builds reasoning.effort and strips temperature when thinking', () => {
    const body = buildDeepSeekResponsesBody(
      {
        model: 'deepseek-v4-flash',
        messages: [
          { role: 'system', content: 'sys' },
          { role: 'user', content: 'hi' },
        ],
        max_tokens: 1024,
        temperature: 0.5,
        reasoning_effort: 'medium',
      },
      { reasoningEffort: 'medium', thinking: 'enabled' },
    )
    assert.equal(body.model, 'deepseek-v4-flash')
    assert.deepEqual(body.reasoning, { effort: 'medium' })
    assert.equal(body.instructions, 'sys')
    assert.equal((body as Record<string, unknown>).temperature, undefined)
    assert.equal(body.max_output_tokens, 1024)
  })

  it('thinking disabled → reasoning.effort none', () => {
    const body = buildDeepSeekResponsesBody(
      { model: 'deepseek-v4-flash', messages: [{ role: 'user', content: 'hi' }] },
      { thinking: 'disabled' },
    )
    assert.deepEqual(body.reasoning, { effort: 'none' })
  })
})
