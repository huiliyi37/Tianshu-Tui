import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { Message } from '../../api/types.js'
import { groupIntoRounds, computeInvariantStatus } from '../../context/rounds.js'

function makeEngine() {
  return new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
    volatileCtx: { cwd: '/repo' },
  })
}

describe('PromptEngine message normalization', () => {
  it('inserts a synthetic tool_result immediately after an unmatched tool_use', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fix the file' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'edit_file', input: { file_path: '/repo/src/a.ts' } }],
      },
      { role: 'user', content: 'continue' },
    ]

    const request = makeEngine().buildRequest(messages)
    const assistantIndex = request.messages.findIndex(msg => msg.role === 'assistant')
    assert.ok(assistantIndex >= 0)
    const next = request.messages[assistantIndex + 1]!

    assert.equal(next.role, 'user')
    assert.ok(Array.isArray(next.content))
    assert.deepEqual(next.content, [{
      type: 'tool_result',
      tool_use_id: 'call_1',
      content: 'Tool result unavailable: recovered from interrupted tool execution.',
      is_error: true,
    }])
  })

  it('keeps a valid tool_use/tool_result pair unchanged', () => {
    const messages: Message[] = [
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_1', name: 'edit_file', input: {} }],
      },
      {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'call_1', content: 'done' }],
      },
    ]

    const request = makeEngine().buildRequest(messages)

    assert.equal(request.messages.length, 2)
    assert.deepEqual(request.messages[1], messages[1])
  })

  it('drops orphan tool_result messages that no longer follow a tool_use', () => {
    const messages: Message[] = [
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'call_orphan', content: 'late' }] },
      { role: 'user', content: 'new request' },
    ]

    const request = makeEngine().buildRequest(messages)

    assert.equal(request.messages.some(msg => Array.isArray(msg.content) && msg.content.some(block => block.type === 'tool_result')), false)
    assert.ok(request.messages.some(msg => msg.role === 'user' && msg.content === 'new request'))
  })

  it('normalizes broken history into API-safe rounds', () => {
    const messages: Message[] = [
      { role: 'user', content: 'fix it' },
      {
        role: 'assistant',
        content: [{ type: 'tool_use', id: 'call_safe', name: 'edit_file', input: { file_path: '/repo/a.ts' } }],
      },
      { role: 'user', content: 'continue' },
    ]

    const request = makeEngine().buildRequest(messages)
    const rounds = groupIntoRounds(request.messages)
    const invariant = computeInvariantStatus(rounds)

    assert.equal(invariant.brokenRounds, 0, `Expected 0 broken rounds, got ${invariant.brokenRounds}`)
  })
})

describe('PromptEngine context layer report', () => {
  it('reports context layers with channels and fingerprint policy', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1000,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/repo',
        rivetMd: 'Use TDD.',
        gitStatus: 'M src/main.tsx',
        sessionMemoryBlock: '<session-memory><entry>decision</entry></session-memory>',
        workingSet: ['src/prompt/engine.ts'],
      },
    })

    const report = engine.getContextLayerReport()
    assert.deepEqual(report.layers.map(l => l.id), [
      'system',
      'tools',
      'project-instructions',
      'git-status',
      'session-memory',
      'working-set',
    ])
    assert.ok(report.fingerprintIncluded.some(l => l.id === 'system'))
    assert.ok(report.fingerprintIncluded.some(l => l.id === 'session-memory'))
    assert.equal(report.dynamicLayers.length, 0)
  })

  it('omits layers with no content', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    const report = engine.getContextLayerReport()
    assert.deepEqual(report.layers.map(l => l.id), ['system', 'tools'])
  })
})
