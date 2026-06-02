import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { PromptEngine } from '../engine.js'
import { stableStringify } from '../../api/stable-json.js'
import { latestUserTrailer } from './helpers/message-selectors.js'
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
  it('message selector parses latest user trailer', () => {
    const parsed = latestUserTrailer([{ role: 'user', content: 'fresh\n---\nhello' }])
    assert.equal(parsed.fresh, 'fresh')
    assert.equal(parsed.user, 'hello')
  })

  it('message selector rejects message lists without user messages', () => {
    assert.throws(() => latestUserTrailer([{ role: 'assistant', content: 'x' }]), /expected at least one user message/)
  })

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
    // P1: sessionState is in standalone appendix, not in user message
    const firstAppendix = first.messages[first.messages.length - 1]!
    assert.match(typeof firstAppendix.content === 'string' ? firstAppendix.content : '', /state v1/)

    engine.setSessionState('state v2')
    const second = engine.buildOaiRequest([
      { role: 'user', content: 'inspect' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'edit_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call_1', content: 'done' },
    ])

    assert.deepEqual(second.messages[1], firstVolatile)
    // P1: sessionState is in appendix, not user message
    const secondAppendix = second.messages[second.messages.length - 1]!
    assert.doesNotMatch(typeof secondAppendix.content === 'string' ? secondAppendix.content : '', /state v2/)
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

    const { fresh, user } = latestUserTrailer(request.messages)
    assert.ok(user.startsWith('continue'), `user should start with 'continue', got '${user.slice(0, 30)}...'`)
    // P1: sessionState is in standalone appendix, not in FROZEN fresh
    const appendix = request.messages[request.messages.length - 1]!
    assert.match(typeof appendix.content === 'string' ? appendix.content : '', /state v2/)
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
    // P1: active domain is in standalone appendix, not in user messages
    const appendix = request.messages[request.messages.length - 1]!
    assert.match(typeof appendix.content === 'string' ? appendix.content : '', /<star-domain name="破军"/)
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

  it('getPhaseHint round-trips with setPhaseHint (wiring for TDD RED exemption)', () => {
    const engine = new PromptEngine({ model: 'test', maxTokens: 8000, staticCtx: { tools: [] }, volatileCtx: { cwd: '/tmp' } })
    assert.equal(engine.getPhaseHint(), undefined)
    engine.setPhaseHint('verify')
    assert.equal(engine.getPhaseHint(), 'verify')
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

    // Should be exactly 2 user messages (trailer merge for both first and last):
    // [0] volatileBlock + '\n---\n' + 'first question' (merged at firstUserIdx)
    // [1] cachedFreshBlock + '\n---\n' + 'second question' (merged at lastUserIdx)
    // firstUserIdx fallback no longer pushes 2 separate messages — that was the
    // very bug that caused index shifts and broke suffix prefix cache.
    assert.equal(userMsgs.length, 2,
      'trailer merge at both firstUserIdx and lastUserIdx = 2 messages')

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

describe('git-dirty flag and toolHistory cap', () => {
  function lastUserContent(req: OaiChatRequest): string {
    for (let i = req.messages.length - 1; i >= 0; i--) {
      if (req.messages[i]!.role === 'user') return req.messages[i]!.content as string
    }
    return ''
  }

  it('markGitDirty causes gitStatus to refresh from cache on next user message', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo', gitStatus: 'Current branch: main\nStatus:\nM old.ts' },
    })

    const req1 = engine.buildOaiRequest([{ role: 'user', content: 'msg1' }])
    assert.ok(lastUserContent(req1).includes('old.ts'), 'first request uses frozen snapshot')

    engine.markGitDirty()
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'msg2' }])
    assert.ok(!lastUserContent(req2).includes('old.ts'), 'after markGitDirty, frozen snapshot is bypassed')
  })

  it('periodic refresh every 3 user messages without markGitDirty', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo', gitStatus: 'Current branch: main\nStatus:\nM stale.ts' },
    })

    engine.buildOaiRequest([{ role: 'user', content: 'a' }])
    const req2 = engine.buildOaiRequest([{ role: 'user', content: 'b' }])
    assert.ok(lastUserContent(req2).includes('stale.ts'), 'message 2 still uses frozen snapshot')

    const req3 = engine.buildOaiRequest([{ role: 'user', content: 'c' }])
    assert.ok(!lastUserContent(req3).includes('stale.ts'), 'message 3 triggers periodic git refresh')
  })

  it('toolHistory caps at 8 most recent entries', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/repo' },
    })

    const history = Array.from({ length: 12 }, (_, i) => ({
      tool: `tool_${i}`,
      target: `target_${i}`,
      status: 'success' as const,
    }))

    const req = engine.buildOaiRequest([{ role: 'user', content: 'x' }], history)
    const vol = lastUserContent(req)
    // P1b: dynamic attributes removed for cache stability; check entry count instead
    const toolCount = (vol.match(/<tool-summary/g) || []).length
    assert.equal(toolCount, 8, 'capped at 8 most recent tool entries')
    assert.ok(!vol.includes('tool_0'), 'oldest entries are dropped')
    assert.ok(vol.includes('tool_11'), 'newest entries are kept')
  })
})

describe('frozenUserMerged eviction', () => {
  it('evicts stale entries when map exceeds max size', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Feed 70 distinct user messages (each becomes an entry in frozenUserMerged)
    const messages: OaiMessage[] = []
    for (let i = 0; i < 70; i++) {
      messages.push({ role: 'user', content: `user message ${i}` })
      engine.buildOaiRequest([...messages])
    }
    // After 70 messages, the frozen cache should have been trimmed to ≤ 64 entries.
    // Oldest entries are evicted. The most recent 64 should still have frozen content.
    const req = engine.buildOaiRequest(messages)
    const userMsgs = req.messages.filter(m => m.role === 'user')
    // The newest 64 user messages should have merged content (volatile + user content)
    const keptMsgs = userMsgs.slice(-64)
    for (const msg of keptMsgs) {
      assert.ok(typeof msg.content === 'string' && msg.content.includes('---'), `recent user message should have merged content`)
    }
    // The last message (freshly built) always has merged content
    const lastMsg = userMsgs[userMsgs.length - 1]
    assert.ok(typeof lastMsg?.content === 'string' && lastMsg.content.includes('---'), 'latest message always has merged content')
  })

  it('preserves frozen content for messages still in the array', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 1024,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    })
    // Create messages, build request, then rebuild with same messages
    const msgs1: OaiMessage[] = [{ role: 'user', content: 'first' }]
    const req1 = engine.buildOaiRequest(msgs1)
    // Find the user message content (after system prompt at index 0)
    const userMsg1 = req1.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('first'))
    assert.ok(userMsg1, 'should find first user message')
    const content1 = userMsg1!.content as string

    // Feed 70 more messages to trigger eviction
    const msgs2: OaiMessage[] = [...msgs1]
    for (let i = 0; i < 70; i++) {
      msgs2.push({ role: 'user', content: `msg ${i}` })
    }
    engine.buildOaiRequest(msgs2)

    // Now rebuild with just the original message — frozen content should still match
    // (because the key "first" is still in msgs2 which was used during eviction)
    const req3 = engine.buildOaiRequest(msgs1)
    const userMsg3 = req3.messages.find(m => m.role === 'user' && typeof m.content === 'string' && m.content.includes('first'))
    assert.ok(userMsg3, 'should find first user message after eviction')
    const content3 = userMsg3!.content as string
    assert.equal(content3, content1, 'frozen content for first message must be preserved')
  })
})
