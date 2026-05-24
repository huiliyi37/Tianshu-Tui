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
    assert.equal(request.messages.length, 4)
    assert.equal(request.messages[0]?.role, 'system')
    // Trailer mode: when firstUserIdx===lastUserIdx, cachedFreshBlock (which
    // includes frozenBase) is merged into the user message — no separate frozenBase msg.
    assert.equal(request.messages[1]?.role, 'user')
    assert.match(request.messages[1]?.content ?? '', /<environment/)
    assert.ok((request.messages[1]?.content ?? '').includes('hello'))
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

  // P1.1: consolidatedBlock must NOT mutate volatileBlock
  it('P1.1a: volatileBlock unchanged after habituation promotion', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 1, // tracker enabled
    })

    const frozenBase = (engine as any).frozenBase as string
    assert.equal((engine as any).volatileBlock, frozenBase, 'volatileBlock should equal frozenBase at startup')

    // Set execute phase (alpha=0.35, fastest habituation) and feed same domain
    // 5 times. At turn 4+: confidence exceeds 0.8 → promotion fires.
    engine.setPhaseHint('execute')
    for (let i = 0; i < 5; i++) {
      engine.setActiveDomain({ name: 'test', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `turn${i}` }])
    }

    // volatileBlock MUST NOT change after habituation promotion
    assert.equal((engine as any).volatileBlock, frozenBase,
      'volatileBlock should remain at frozenBase after habituation promotion')
  })

  it('P1.1b: consolidatedBlock injected into dynamic appendix, not frozen prefix', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 1, // tracker enabled
    })

    engine.setPhaseHint('execute')

    // Feed same star-domain across 5 turns (each calls buildOaiRequest so
    // tracker records the turn). Execute phase alpha=0.35 → 4 turns to
    // exceed 0.8 confidence → habituation fires on turn 5.
    for (let i = 1; i <= 5; i++) {
      engine.setActiveDomain({ name: 'orion', volatileBlock: 'star-data', motto: 'guide' })
      engine.buildOaiRequest([{ role: 'user', content: `turn${i}` }])
    }

    // Build request for turn 6 — consolidatedBlock (with habituated domain)
    // should be in the LAST injected user message (cachedFreshBlock), which is
    // the second-to-last user message (original msg is appended after it)
    const req = engine.buildOaiRequest([{ role: 'user', content: 'final' }])

    const allUsers = req.messages.filter(m => m.role === 'user')
    // Trailer mode: cachedFreshBlock is merged into the LAST user message
    const injectedBlock = allUsers[allUsers.length - 1]?.content ?? ''

    // consolidatedBlock with habituated domain should appear in merged message
    assert.ok(injectedBlock.includes('star-data'),
      'Habituated domain content should appear in last user message (trailer mode)')

    // frozenBase should NOT contain the habituated domain
    assert.ok(!(engine as any).frozenBase.includes('star-data'),
      'Frozen base should NOT contain habituated content')
  })

  // Trailer mode: cachedFreshBlock is merged into the last user message's content
  // instead of being injected as a separate user message. This keeps the message
  // array append-only, preserving DeepSeek exact-prefix cache byte stability.
  it('P2: cachedFreshBlock merged into last user message, not as separate message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
      habituationThreshold: 0,
    })

    const req = engine.buildOaiRequest([
      { role: 'user', content: 'first question' },
      { role: 'assistant', content: 'first answer' },
      { role: 'user', content: 'second question' },
    ])

    const userMsgs = req.messages.filter(m => m.role === 'user')

    // Should be exactly 3 user messages:
    // [0] frozenBase (injected at firstUserIdx)
    // [1] 'first question' (original)
    // [2] cachedFreshBlock + '\n---\n' + 'second question' (merged)
    // NOT 4 messages (with cachedFreshBlock as separate msg)
    assert.equal(userMsgs.length, 3,
      'cachedFreshBlock should be merged into last user msg, not separate')

    const lastUserMsg = userMsgs[userMsgs.length - 1]!
    assert.ok((lastUserMsg.content as string).includes('second question'),
      'last user msg must contain original user input')
    assert.ok((lastUserMsg.content as string).includes('<context>'),
      'last user msg must contain cachedFreshBlock (volatile context)')
  })

  // Phase 2.2: On 1M+ context windows, skip observation masking entirely.
  // The 1M window has enough headroom. trySessionSplit (86%) is the primary
  // defense against context overflow. Masking mutates message content which
  // breaks exact prefix cache — skipping it maximizes cache stability.
  it('P2.2: skips observation mask on 1M+ context window regardless of turn count', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 8000,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/tmp' },
    })

    // Build 85 turns — well over the 10-turn mask window for small windows
    const messages: OaiMessage[] = []
    for (let i = 0; i < 85; i++) {
      messages.push({ role: 'user', content: `q${i}` })
      messages.push({ role: 'assistant', content: `a${i}` })
      messages.push({
        role: 'tool' as const,
        tool_call_id: `call_${i}`,
        content: `result content for tool call ${i} `.padEnd(3000, 'x'),
      })
    }

    // Without contextWindow: old tool results should be masked (MASK_WINDOW=10)
    const reqWithoutCW = engine.buildOaiRequest(messages)
    const maskedCountWithoutCW = reqWithoutCW.messages.filter(
      (m: any) => m.role === 'tool' && m.content.startsWith('[observation masked')
    ).length
    assert.ok(maskedCountWithoutCW > 0,
      'old tool results should be masked without contextWindow')

    // With contextWindow >= 1M: NO masking even at 85 turns (>> MASK_WINDOW=10)
    const reqWith1M = engine.buildOaiRequest(messages, undefined, 1_000_000)
    const maskedCountWith1M = reqWith1M.messages.filter(
      (m: any) => m.role === 'tool' && m.content.startsWith('[observation masked')
    ).length
    assert.equal(maskedCountWith1M, 0,
      'no tool results should be masked on 1M window — skip entirely')

    // Byte stability: calling twice with same args should produce identical messages
    const req2 = engine.buildOaiRequest(messages, undefined, 1_000_000)
    assert.deepStrictEqual(
      req2.messages.map(m => m.content),
      reqWith1M.messages.map(m => m.content),
      'repeated calls should produce identical content for cache stability'
    )
  })
})
