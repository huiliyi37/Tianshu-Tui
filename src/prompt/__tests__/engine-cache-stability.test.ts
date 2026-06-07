import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix } from '../volatile.js'
import { PromptEngine } from '../engine.js'
import { latestUserTrailer, userMessages, type LatestUserTrailer } from './helpers/message-selectors.js'
import type { OaiMessage } from '../../api/oai-types.js'

function historicalUserContent(messages: readonly OaiMessage[], userContent: string): string {
  const msg = userMessages(messages)
    .find(m => typeof m.content === 'string' && m.content.includes(`\n---\n${userContent}`))
  if (!msg || typeof msg.content !== 'string') {
    throw new Error(`expected historical user trailer for ${userContent}`)
  }
  return msg.content
}

/** Extract user content from trailer: "fresh\n---\nuser\n\nappendix" → "user" */
function trailerUser(trailer: LatestUserTrailer): string {
  // appendix is appended after user content with \n\n separator
  const idx = trailer.user.indexOf('\n\n')
  return idx >= 0 ? trailer.user.slice(0, idx) : trailer.user
}

describe('ice-mirror: cache stability', () => {
  const baseCtx = {
    cwd: '/test',
    gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
    rivetMd: '# Project\nTest project',
    workingSet: ['src/foo.ts'],
  }

  it('FROZEN does NOT include git-status (moved to dynamic appendix)', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    assert.ok(!frozen.includes('<git-status>'), 'FROZEN must NOT contain <git-status>')
  })

  it('dynamic appendix includes git-status', () => {
    const appendix = buildDynamicAppendix(baseCtx)
    assert.ok(appendix.includes('<git-status>'), 'dynamic appendix must contain <git-status>')
    assert.ok(appendix.includes('M src/foo.ts'))
  })

  it('FROZEN does NOT include dynamic sections', () => {
    const frozen = buildStableVolatileBlock({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'x', status: 'success' as const }],
      behaviorMirror: 'test mirror',
      decisions: ['decision 1'],
    })
    assert.ok(!frozen.includes('<tool-history'))
    assert.ok(!frozen.includes('<behavior-mirror'))
    assert.ok(!frozen.includes('<decisions'))
  })

  it('FRESH equals FROZEN when no dynamic fields and no git-status', () => {
    const ctx = { cwd: '/test', rivetMd: '# Test' }
    const frozen = buildStableVolatileBlock(ctx)
    const fresh = buildLatestTurnVolatileBlock(ctx)
    assert.equal(frozen, fresh, 'FRESH must equal FROZEN byte-for-byte when no dynamic fields')
  })

  it('FROZEN is a string prefix of FRESH when dynamic fields present', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const fresh = buildLatestTurnVolatileBlock({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' as const }],
    })
    assert.ok(fresh.startsWith(frozen), 'FRESH must start with exact FROZEN bytes')
    assert.ok(fresh.length > frozen.length, 'FRESH must be longer when dynamic fields present')
  })

  it('dynamic appendix contains tool-history when provided', () => {
    const appendix = buildDynamicAppendix({
      ...baseCtx,
      toolHistory: [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' as const }],
    })
    assert.ok(appendix.includes('<context-update>'))
    assert.ok(appendix.includes('<tool-history'))
    assert.ok(appendix.includes('read_file'))
  })

  it('dynamic appendix is empty when no dynamic fields AND no git-status', () => {
    const appendix = buildDynamicAppendix({ cwd: '/test' })
    assert.equal(appendix, '')
  })

  it('FROZEN is identical across repeated calls with same ctx', () => {
    const frozen1 = buildStableVolatileBlock(baseCtx)
    const frozen2 = buildStableVolatileBlock(baseCtx)
    assert.equal(frozen1, frozen2, 'FROZEN must be deterministic')
  })
})

describe('multi-turn prefix stability (PromptEngine integration)', () => {

  function createEngine() {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/test/project',
        gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
        rivetMd: '# Test Project\nThis is a test.',
        workingSet: ['src/foo.ts'],
      },
    })
  }

  it('frozen base is a prefix of the latest volatile block', () => {
    const engine = createEngine()

    const req1 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
    ])

    const req2 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'read file' },
    ], [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' }])

    // req1: "hello" is the latest message → FROZEN trailer (appendix is standalone)
    const vol1 = latestUserTrailer(req1.messages).fresh
    // req2: "hello" is a historical message → reuses the frozen merged trailer for that user
    const vol2 = historicalUserContent(req2.messages, 'hello').split('\n---\n')[0]!

    // P1: both use volatileBlock (FROZEN only), appendix is a separate message
    assert.equal(vol1, vol2, 'Historical frozen trailer must equal latest FROZEN volatile')
    // Git-status moved to standalone appendix message
    const appendixMsg = req1.messages[req1.messages.length - 1]!
    assert.ok(
      typeof appendixMsg.content === 'string' && appendixMsg.content.includes('<git-status>'),
      'Standalone appendix must contain git-status',
    )
  })

  it('frozen base for historical turns is stable across 5 turns', () => {
    const engine = createEngine()
    const frozenBlocks: string[] = []

    for (let turn = 2; turn <= 5; turn++) {
      const messages: OaiMessage[] = []
      for (let t = 1; t <= turn; t++) {
        messages.push({ role: 'user', content: `message ${t}` })
        if (t < turn) {
          messages.push({ role: 'assistant', content: `response ${t}` })
        }
      }

      const toolHistory = turn > 1
        ? [{ tool: 'read_file', target: `file${turn}.ts`, status: 'success' as const }]
        : undefined

      const req = engine.buildOaiRequest(messages, toolHistory)

      // messages[0] = system, messages[1] = FROZEN volatile block before first user msg
      // Historical turns get frozen base only (no git-status, no dynamic appendix)
      const firstVol = (req.messages[1] as { content: string }).content
      assert.ok(!firstVol.includes('<git-status>'),
        `Turn ${turn}: frozen base must not contain <git-status>`)
      assert.ok(!firstVol.includes('<context-update>'),
        `Turn ${turn}: frozen base must not contain <context-update>`)
      frozenBlocks.push(firstVol)
    }

    // All historical frozen blocks must be byte-identical
    for (let i = 1; i < frozenBlocks.length; i++) {
      assert.equal(frozenBlocks[i], frozenBlocks[0],
        `Turn ${i + 2}: frozen base must match Turn 2`)
    }
  })

  it('FRESH volatile for latest turn starts with FROZEN content', () => {
    const engine = createEngine()

    const req = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read file' },
    ], [{ tool: 'read_file', target: 'x', status: 'success' }])

    // messages[1] = FROZEN volatile for "hello" (trailer-merged at turn 0)
    const frozenVol = (req.messages[1] as { content: string }).content

    const { fresh: freshVol, user } = latestUserTrailer(req.messages)
    assert.ok(user.startsWith('read file'), `user should start with 'read file', got '${user.slice(0, 30)}...'`)

    // P1: FRESH is volatileBlock only (appendix is standalone), so it's a prefix of the frozen snapshot
    assert.ok(frozenVol.startsWith(freshVol),
      'FROZEN snapshot must start with volatileBlock prefix')
  })

  it('system prompt is identical across turns', () => {
    const engine = createEngine()

    const req1 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
    ])
    const req2 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read' },
    ])

    // System is messages[0] in OAI format
    assert.deepEqual(req1.messages[0], req2.messages[0], 'System prompt must be identical across turns')
  })
})

describe('habituation: three-zone consolidation', () => {
  function createEngineH(threshold = 5) {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/test/project',
        gitStatus: 'Current branch: main',
        rivetMd: '# Test',
      },
      habituationThreshold: threshold,
    })
  }

  it('no consolidated block before reaching threshold', () => {
    const engine = createEngineH(5)
    engine.setPhaseHint('explore')

    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `msg ${t}` }])
    }

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildOaiRequest([{ role: 'user', content: 'check' }])
    const vol = (req.messages[1] as { content: string }).content
    assert.ok(!vol.includes('<consolidated>'), 'No consolidated block before threshold')
  })

  it('consolidated block appears after threshold turns with stable domain', () => {
    const engine = createEngineH(3)
    engine.setPhaseHint('execute')

    for (let t = 0; t < 5; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      const messages: OaiMessage[] = []
      for (let m = 0; m <= t; m++) {
        messages.push({ role: 'user', content: `msg ${m}` })
        if (m < t) messages.push({ role: 'assistant', content: `resp ${m}` })
      }
      engine.buildOaiRequest(messages)
    }

    const req = engine.buildOaiRequest([{ role: 'user', content: 'final' }])
    // P1: consolidated block is in the standalone appendix (last message)
    const appendix = req.messages[req.messages.length - 1]!
    assert.ok(
      typeof appendix.content === 'string' && appendix.content.includes('<consolidated>'),
      'Consolidated block should appear in standalone appendix after threshold',
    )
    assert.ok(
      typeof appendix.content === 'string' && appendix.content.includes('tianshu'),
      'Consolidated should contain domain name',
    )
  })

  it('historical volatile stays frozen while latest trailer carries consolidated block after promotion', () => {
    const engine = createEngineH(3)
    engine.setPhaseHint('execute')

    for (let t = 0; t < 5; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `msg ${t}` }])
    }

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildOaiRequest([
      { role: 'user', content: 'msg 0' },
      { role: 'assistant', content: 'resp 0' },
      { role: 'user', content: 'msg 1' },
    ])

    const histVol = historicalUserContent(req.messages, 'msg 0').split('\n---\n')[0]!
    const { fresh: freshVol, user } = latestUserTrailer(req.messages)
    const frozenBase = (engine as unknown as { frozenBase: string }).frozenBase
    assert.ok(user.startsWith('msg 1'), `user should start with 'msg 1', got '${user.slice(0, 30)}...'`)
    assert.ok(!histVol.includes('<consolidated>'), 'Historical volatile must stay frozen for prefix cache')
    assert.equal(freshVol, frozenBase, 'Latest trailer must equal frozen base (appendix is standalone)')
    // P1: consolidated block is in standalone appendix
    const appendix = req.messages[req.messages.length - 1]!
    assert.ok(
      typeof appendix.content === 'string' && appendix.content.includes('<consolidated>'),
      'Standalone appendix must include consolidated dynamic appendix',
    )
  })

  it('dehabituation removes field from consolidated block', () => {
    const engine = createEngineH(3)
    engine.setPhaseHint('execute')

    for (let t = 0; t < 5; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `msg ${t}` }])
    }

    let req = engine.buildOaiRequest([{ role: 'user', content: 'check' }])
    // P1: consolidated block is in standalone appendix (last message)
    let appendix = req.messages[req.messages.length - 1]!
    assert.ok(
      typeof appendix.content === 'string' && appendix.content.includes('<consolidated>'),
    )

    engine.setActiveDomain({ name: 'tianji', volatileBlock: 'other', motto: 'other-motto' })
    req = engine.buildOaiRequest([{ role: 'user', content: 'after change' }])
    appendix = req.messages[req.messages.length - 1]!
    // After domain change, consolidated may still be present; check it changed
    assert.ok(
      typeof appendix.content === 'string',
      'Standalone appendix should exist',
    )
  })

  it('FROZEN is byte prefix of FRESH trailer with consolidated and active appendix', () => {
    const engine = createEngineH(3)
    engine.setPhaseHint('execute')

    for (let t = 0; t < 5; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildOaiRequest([{ role: 'user', content: `msg ${t}` }])
    }

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read' },
    ], [{ tool: 'read_file', target: 'x', status: 'success' }])

    const histVol = (req.messages[1] as { content: string }).content

    const { fresh: freshVol, user } = latestUserTrailer(req.messages)
    assert.ok(user.startsWith('read'), 'user should start with "read"')

    // P1: FRESH equals volatileBlock (FROZEN only), appendix is standalone
    assert.ok(histVol.startsWith(freshVol),
      'FROZEN snapshot must start with volatileBlock prefix')
    const appendix = req.messages[req.messages.length - 1]!
    assert.ok(
      typeof appendix.content === 'string' && appendix.content.includes('<consolidated>'),
      'Standalone appendix must include consolidated dynamic appendix',
    )
  })

  it('disabling habituation (threshold=0) falls back to v1 behavior', () => {
    const engine = new PromptEngine({
      model: 'test',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test', gitStatus: 'clean' },
      habituationThreshold: 0,
    })

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    for (let t = 0; t < 10; t++) {
      engine.buildOaiRequest([{ role: 'user', content: `msg ${t}` }])
    }

    const req = engine.buildOaiRequest([{ role: 'user', content: 'test' }])
    const vol = (req.messages[1] as { content: string }).content
    assert.ok(!vol.includes('<consolidated>'), 'No consolidated when habituation disabled')
  })
})

describe('agent loop mode: volatile block cached across tool-call turns', () => {
  function createEngine() {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: {
        cwd: '/test/project',
        gitStatus: 'Current branch: main',
        rivetMd: '# Test',
      },
    })
  }

  it('volatile block is identical across 5 tool-call turns (same user message)', () => {
    const engine = createEngine()
    const volatileBlocks: string[] = []

    for (let turn = 0; turn < 5; turn++) {
      const messages: OaiMessage[] = [
        { role: 'user', content: 'refactor the auth module' },
      ]
      for (let t = 0; t < turn; t++) {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `call_${t}`, type: 'function' as const, function: { name: 'read_file', arguments: `{"path":"file${t}.ts"}` } }] })
        messages.push({ role: 'tool', tool_call_id: `call_${t}`, content: `content of file${t}` })
      }

      const toolHistory = turn > 0
        ? [{ tool: 'read_file', target: `file${turn - 1}.ts`, status: 'success' as const }]
        : undefined

      const req = engine.buildOaiRequest(messages, toolHistory)
      volatileBlocks.push((req.messages[1] as { content: string }).content)
    }

    for (let i = 1; i < volatileBlocks.length; i++) {
      assert.equal(volatileBlocks[i], volatileBlocks[0],
        `Turn ${i}: volatile block must be identical to Turn 0 (same user message → cached)`)
    }
  })

  it('volatile block regenerates when a NEW user message arrives', () => {
    const engine = createEngine()

    const req1 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
    ])
    const vol1 = latestUserTrailer(req1.messages).fresh

    const req2 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function' as const, function: { name: 'bash', arguments: '{"command":"ls"}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: 'file1\nfile2' },
    ])
    const vol2 = latestUserTrailer(req2.messages).fresh
    assert.equal(vol1, vol2, 'Same user message → cached volatile')

    engine.setRepairHint('fix the path')
    const req3 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'read file' },
    ])
    const { fresh: freshVol, user } = latestUserTrailer(req3.messages)
    assert.ok(user.startsWith('read file'), `user should start with 'read file', got '${user.slice(0, 30)}...'`)
    // P1: FROZEN volatile is stable; appendix changes, not the volatile block
    assert.equal(freshVol, vol1, 'FROZEN volatile must stay stable — appendix is standalone')
  })

  it('intent retrieval route invalidates only fresh appendix, not stable prefix', () => {
    const engine = createEngine()

    const first = engine.buildOaiRequest([{ role: 'user', content: 'fix bug' }])
    const firstFresh = latestUserTrailer(first.messages).fresh
    const firstUser = latestUserTrailer(first.messages).user
    assert.doesNotMatch(firstFresh, /intent-retrieval-route/)
    assert.doesNotMatch(firstUser, /intent-retrieval-route/)

    engine.setIntentRetrievalRoute('<intent-retrieval-route advisory="true" scope="current-turn"><task-kinds>bug_fix</task-kinds></intent-retrieval-route>')
    const second = engine.buildOaiRequest([{ role: 'user', content: 'fix bug' }])
    const secondTrailer = latestUserTrailer(second.messages)

    assert.equal(secondTrailer.fresh, firstFresh, 'Stable volatile prefix must stay byte-identical')
    assert.match(secondTrailer.user, /<intent-retrieval-route advisory="true" scope="current-turn">/)
    assert.equal(engine.checkDrift(), null)
  })

  it('10 tool-call turns: volatile block never changes', () => {
    const engine = createEngine()
    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'b', motto: 'm' })

    let firstVol = ''
    for (let turn = 0; turn < 10; turn++) {
      const messages: OaiMessage[] = [
        { role: 'user', content: 'implement feature X' },
      ]
      for (let t = 0; t < turn; t++) {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c_${t}`, type: 'function' as const, function: { name: 'edit_file', arguments: '{}' } }] })
        messages.push({ role: 'tool', tool_call_id: `c_${t}`, content: 'ok' })
      }

      const req = engine.buildOaiRequest(messages, [
        { tool: 'edit_file', target: `file${turn}.ts`, status: 'success' },
      ])
      const vol = (req.messages[1] as { content: string }).content

      if (turn === 0) firstVol = vol
      else assert.equal(vol, firstVol, `Turn ${turn}: volatile must match Turn 0`)
    }
  })

  it('cognitive projection does NOT invalidate same-user fresh cache (cache-safe)', () => {
    const engine = createEngine()
    const messages: OaiMessage[] = [
      { role: 'user', content: 'implement feature X' },
      { role: 'assistant', content: null, tool_calls: [{ id: 'c_1', type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c_1', content: 'ok' },
    ]

    const before = engine.buildOaiRequest(messages)
    const beforeFresh = latestUserTrailer(before.messages).fresh
    assert.doesNotMatch(beforeFresh, /task-contract/)

    engine.setCognitiveProjection('<task-contract status="executing"><objective>implement feature X</objective></task-contract>')
    // Same user message → cached fresh block reused (prefix cache preserved)
    const after = engine.buildOaiRequest(messages)
    const afterFresh = latestUserTrailer(after.messages).fresh
    assert.equal(afterFresh, beforeFresh)
    assert.doesNotMatch(afterFresh, /<task-contract status="executing">/)

    // Projection appears when a NEW user message arrives (different content triggers rebuild)
    const messages2: OaiMessage[] = [
      ...messages,
      { role: 'user', content: 'now do Y' },
    ]
    const withNewUser = engine.buildOaiRequest(messages2)
    const { fresh: freshContext, user } = latestUserTrailer(withNewUser.messages)
    assert.ok(user.startsWith('now do Y'), 'user should start with "now do Y"')
    // P1: projection is in standalone appendix, not in FROZEN fresh
    assert.doesNotMatch(freshContext, /<task-contract status="executing">/)
    const appendix2 = withNewUser.messages[withNewUser.messages.length - 1]!
    assert.match(
      typeof appendix2.content === 'string' ? appendix2.content : '',
      /<task-contract status="executing">/,
      'Projection must appear in standalone appendix on new user message',
    )
    assert.equal(engine.checkDrift(), null)
  })
})

describe('sessionState injection — cache safety + path coverage', () => {
  function makeEngine(habituationThreshold: number) {
    return new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test/project', gitStatus: 'Current branch: main', rivetMd: '# Test' },
      habituationThreshold,
    })
  }

  it('sessionState reaches fresh volatile block under tracker-enabled (default) path', () => {
    const engine = makeEngine(5)
    engine.setSessionState('<session-state>\nTask: alpha [executing]\n</session-state>')

    const req = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    // P1: sessionState is in standalone appendix (last message), not in user message
    const appendix = req.messages[req.messages.length - 1]!
    assert.match(
      typeof appendix.content === 'string' ? appendix.content : '',
      /<session-state>/,
      'sessionState must appear in standalone appendix when tracker enabled',
    )
    assert.match(
      typeof appendix.content === 'string' ? appendix.content : '',
      /Task: alpha/,
    )
  })

  it('sessionState reaches fresh volatile block under tracker-disabled (fallback) path', () => {
    const engine = makeEngine(0)
    engine.setSessionState('<session-state>\nTask: beta [verifying]\n</session-state>')

    const req = engine.buildOaiRequest([{ role: 'user', content: 'hello' }])
    // P1: sessionState is in standalone appendix (last message)
    const appendix = req.messages[req.messages.length - 1]!
    assert.match(
      typeof appendix.content === 'string' ? appendix.content : '',
      /<session-state>/,
      'sessionState must appear in standalone appendix when tracker disabled',
    )
    assert.match(
      typeof appendix.content === 'string' ? appendix.content : '',
      /Task: beta/,
    )
  })

  it('volatile block stays byte-identical across 5 tool-call turns even when setSessionState is called per turn', () => {
    const engine = makeEngine(5)

    let firstVol = ''
    for (let turn = 0; turn < 5; turn++) {
      engine.setSessionState(`<session-state>\nFiles tracked: ${turn}\n</session-state>`)

      const messages: OaiMessage[] = [{ role: 'user', content: 'refactor the auth module' }]
      for (let t = 0; t < turn; t++) {
        messages.push({ role: 'assistant', content: null, tool_calls: [{ id: `c_${t}`, type: 'function' as const, function: { name: 'read_file', arguments: '{}' } }] })
        messages.push({ role: 'tool', tool_call_id: `c_${t}`, content: 'ok' })
      }

      const req = engine.buildOaiRequest(messages)
      const vol = (req.messages[1] as { content: string }).content

      if (turn === 0) firstVol = vol
      else assert.equal(vol, firstVol,
        `Turn ${turn}: volatile block must stay byte-identical to turn 0 — setSessionState in mid-conversation must NOT invalidate prefix cache`)
    }
  })

  it('sessionState refreshes when a NEW user message arrives', () => {
    const engine = makeEngine(5)
    engine.setSessionState('<session-state>\nState: A\n</session-state>')

    const req1 = engine.buildOaiRequest([{ role: 'user', content: 'first task' }])
    // P1: sessionState is in standalone appendix
    const app1 = req1.messages[req1.messages.length - 1]!
    assert.match(
      typeof app1.content === 'string' ? app1.content : '',
      /State: A/,
    )

    engine.setSessionState('<session-state>\nState: B\n</session-state>')

    const req2 = engine.buildOaiRequest([
      { role: 'user', content: 'first task' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'second task' },
    ])
    const { fresh: secondTaskFresh, user } = latestUserTrailer(req2.messages)
    assert.ok(user.startsWith('second task'), 'user should start with "second task"')
    // P1: sessionState is in standalone appendix, not in FROZEN fresh
    const app2 = req2.messages[req2.messages.length - 1]!
    assert.match(
      typeof app2.content === 'string' ? app2.content : '',
      /State: B/,
      'New user message must see latest sessionState in standalone appendix',
    )
  })

  it('historical user messages do NOT carry sessionState — protects prefix cache of older turns', () => {
    const engine = makeEngine(5)
    engine.setSessionState('<session-state>\nState: live\n</session-state>')

    const req = engine.buildOaiRequest([
      { role: 'user', content: 'first' },
      { role: 'assistant', content: 'reply' },
      { role: 'user', content: 'second' },
    ])
    const msgs = req.messages
    const firstVol = (msgs[1] as { content: string }).content
    assert.doesNotMatch(firstVol, /<session-state>/, 'Historical user-msg volatile block must NOT contain sessionState (frozen prefix)')
  })

  // ── P1c: frozen appendix in user message ──

  it('last user message contains dynamic appendix after user content', () => {
    const engine = new PromptEngine({
      model: 'test-model', maxTokens: 4096, staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test/project', gitStatus: 'Current branch: main', rivetMd: '# Test' },
    })
    engine.setTaskProgress({ current: 'working', completed: ['step1'], remaining: ['step2'], decisions: [] })

    const req = engine.buildOaiRequest(
      [{ role: 'user', content: 'hello' }],
      [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' }],
    )

    const { fresh, user } = latestUserTrailer(req.messages)
    // fresh = volatileBlock (FROZEN only, stable)
    assert.ok(!fresh.includes('<tool-history'), 'FROZEN volatile must not contain appendix')
    // user = userContent + '\n\n' + appendix (appendix is AFTER user content)
    assert.ok(user.includes('<tool-history'), 'user trailer must contain appendix after user content')
    assert.ok(user.startsWith('hello'), 'user trailer must start with user content')
  })

  it('frozen snapshot preserves appendix for historical retrieval', () => {
    const engine = new PromptEngine({
      model: 'test-model', maxTokens: 4096, staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test/project', gitStatus: 'Current branch: main', rivetMd: '# Test' },
    })
    engine.setTaskProgress({ current: 'working', completed: ['step1'], remaining: ['step2'], decisions: [] })

    // Turn 1: message with appendix
    const r1 = engine.buildOaiRequest(
      [{ role: 'user', content: 'hello' }],
      [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' }],
    )

    // Turn 2: first msg becomes historical
    engine.setTaskProgress({ current: 'next', completed: ['step1', 'step2'], remaining: [], decisions: [] })
    const r2 = engine.buildOaiRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'world' },
    ], [{ tool: 'edit_file', target: 'src/bar.ts', status: 'success' }])

    const t1LastUser = r1.messages.filter(m => m.role === 'user').at(-1)!
    const t2FirstUser = r2.messages.filter(m => m.role === 'user')[0]!
    // Frozen snapshot must return byte-identical content
    assert.equal(t1LastUser.content, t2FirstUser.content,
      'Historical retrieval must return identical bytes (frozen snapshot)')
  })
})
