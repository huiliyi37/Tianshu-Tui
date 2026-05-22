import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import type { Message } from '../../api/types.js'
import type { OaiMessage } from '../../api/oai-types.js'
import { groupIntoRounds, computeInvariantStatus } from '../../context/rounds.js'

function makeEngine() {
  return new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
    volatileCtx: { cwd: '/repo' },
  })
}

describe('PromptEngine OpenAI-native request building', () => {
  it('injects volatile user messages around OAI user messages only', () => {
    const engine = makeEngine()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]

    const request = engine.buildOaiRequest(messages)

    assert.equal(request.model, 'test')
    assert.equal(request.max_tokens, 1024)
    assert.equal(request.stream, true)
    assert.equal(request.tool_choice, 'auto')
    assert.equal(request.tools?.[0]?.type, 'function')
    assert.equal(request.tools?.[0]?.function.name, 'edit_file')
    assert.equal(request.messages.length, 4)
    assert.equal(request.messages[0]?.role, 'user')
    assert.match(request.messages[0]?.content ?? '', /<environment/)
    assert.deepEqual(request.messages.slice(1), messages)
  })

  it('reuses cached fresh volatile across tool-call turns for the same latest user message', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')

    const first = engine.buildOaiRequest([{ role: 'user', content: 'inspect' }])
    const firstVolatile = first.messages[0]
    assert.equal(firstVolatile?.role, 'user')
    assert.match(firstVolatile?.content ?? '', /state v1/)

    engine.setSessionState('state v2')
    const second = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ])

    assert.deepEqual(second.messages[0], firstVolatile)
    assert.doesNotMatch(second.messages[0]?.content ?? '', /state v2/)
  })

  it('refreshes cached fresh volatile at a new user message boundary', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')
    engine.buildOaiRequest([{ role: 'user', content: 'inspect' }])

    engine.setSessionState('state v2')
    const request = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'continue' },
    ])

    const injectedBeforeLatest = request.messages[3]
    assert.equal(injectedBeforeLatest?.role, 'user')
    assert.match(injectedBeforeLatest?.content ?? '', /state v2/)
  })
})

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

describe('PromptEngine active claims projection', () => {
  it('updated active claims appear in the latest turn request without entering historical stable context', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.updateActiveClaims([{
      id: 'c1',
      kind: 'user_constraint',
      scope: 'session',
      status: 'active',
      text: 'Run tests before claiming done',
      confidence: 0.9,
      fitness: 5,
      source: { actor: 'user', sessionId: 'session-123', turn: 1, eventId: 'e1' },
      evidence: [{ id: 'e1', kind: 'user_message', summary: 'Run tests before claiming done', createdAt: 1 }],
      counterevidence: [],
      consumers: [],
      createdAt: 1,
      lastUsedAt: 1,
      tags: ['anchor'],
    }])

    const request = engine.buildRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second turn' },
    ])

    const contextMessages = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<context>'))

    assert.equal(contextMessages.length, 2)
    // Harness-only: activeClaims are no longer rendered into the LLM prompt (direction A)
    assert.doesNotMatch(contextMessages[0]!.content as string, /active-claims/)
    assert.doesNotMatch(contextMessages[1]!.content as string, /active-claims/)
  })

  it('updated session memory appears in the latest turn request', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.updateSessionMemory('<session-memory session_id="s1">\n<entry id="m1" created_at="1" source="manual">Use JSONL first</entry>\n</session-memory>')

    const request = engine.buildRequest([{ role: 'user', content: 'remember this' }])
    const context = request.messages[0]!.content as string

    assert.match(context, /<session-memory>/)
    assert.match(context, /&lt;session-memory session_id=&quot;s1&quot;&gt;/)
    assert.match(context, /Use JSONL first/)
    assert.doesNotMatch(context, /<session-memory session_id="s1">/)
  })

  it('updated active domain appears only in latest volatile context', () => {
    const engine = new PromptEngine({
      model: 'deepseek-test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    engine.setActiveDomain({ name: '破军', motto: '好男儿当负三尺剑立不世之功', volatileBlock: '你当前在破军域。' })

    const request = engine.buildRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '探索新的缓存方案' },
    ])
    const contextMessages = request.messages.filter(message => message.role === 'user' && typeof message.content === 'string' && message.content.includes('<context>'))

    assert.equal(contextMessages.length, 2)
    assert.doesNotMatch(contextMessages[0]!.content as string, /star-domain/)
    assert.match(contextMessages[1]!.content as string, /<star-domain name="破军"/)
    assert.equal(engine.checkDrift(), null)
  })
})
