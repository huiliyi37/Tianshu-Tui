import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { stableStringify } from '../../api/stable-json.js'
import type { OaiChatRequest, OaiMessage } from '../../api/oai-types.js'

function makeEngine() {
  return new PromptEngine({
    model: 'test',
    maxTokens: 1024,
    staticCtx: { tools: [{ name: 'edit_file', description: 'Edit file', input_schema: { type: 'object', properties: {} } }] },
    volatileCtx: { cwd: '/repo' },
  })
}

function canonicalOaiBody(request: OaiChatRequest): Record<string, unknown> {
  return {
    model: request.model,
    messages: request.messages,
    max_tokens: request.max_tokens,
    stream: request.stream,
    stream_options: request.stream_options,
    tools: request.tools,
    tool_choice: request.tool_choice,
  }
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
    assert.equal(request.messages.length, 5)
    assert.equal(request.messages[0]?.role, 'system')
    assert.equal(request.messages[1]?.role, 'user')
    assert.match(request.messages[1]?.content ?? '', /<environment/)
    assert.deepEqual(request.messages.slice(2), messages)
  })

  it('reuses cached fresh volatile across tool-call turns for the same latest user message', () => {
    const engine = makeEngine()
    engine.setSessionState('state v1')

    const first = engine.buildOaiRequest([{ role: 'user', content: 'inspect' }])
    const firstVolatile = first.messages[1]
    assert.equal(firstVolatile?.role, 'user')
    assert.match(firstVolatile?.content ?? '', /state v1/)

    engine.setSessionState('state v2')
    const second = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ])

    assert.deepEqual(second.messages[1], firstVolatile)
    assert.doesNotMatch(second.messages[1]?.content ?? '', /state v2/)
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

    const injectedBeforeLatest = request.messages[4]
    assert.equal(injectedBeforeLatest?.role, 'user')
    assert.match(injectedBeforeLatest?.content ?? '', /state v2/)
  })

  it('produces stable canonical OAI body bytes for equivalent construction', () => {
    const messages: OaiMessage[] = [
      { role: 'user', content: 'hello' },
      {
        role: 'assistant',
        content: null,
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{"file_path":"a.ts"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ]

    const requestA = makeEngine().buildOaiRequest(messages)
    const requestB = makeEngine().buildOaiRequest(messages)

    assert.equal(stableStringify(canonicalOaiBody(requestA)), stableStringify(canonicalOaiBody(requestB)))
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

    const request = engine.buildOaiRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: 'second turn' },
    ])

    const contextMessages = request.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<context>')
    )

    assert.equal(contextMessages.length, 2)
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

    const request = engine.buildOaiRequest([{ role: 'user', content: 'remember this' }])
    const context = request.messages[1]!.content as string

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

    const request = engine.buildOaiRequest([
      { role: 'user', content: 'first turn' },
      { role: 'assistant', content: 'ok' },
      { role: 'user', content: '探索新的缓存方案' },
    ])

    const contextMessages = request.messages.filter(
      msg => msg.role === 'user' && typeof msg.content === 'string' && msg.content.includes('<context>')
    )

    assert.equal(contextMessages.length, 2)
    assert.doesNotMatch(contextMessages[0]!.content as string, /star-domain/)
    assert.match(contextMessages[1]!.content as string, /<star-domain name="破军"/)
    assert.equal(engine.checkDrift(), null)
  })
})
