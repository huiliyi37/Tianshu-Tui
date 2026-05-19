import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildStableVolatileBlock, buildLatestTurnVolatileBlock, buildDynamicAppendix } from '../volatile.js'
import { PromptEngine } from '../engine.js'
import type { Message } from '../../api/types.js'

describe('ice-mirror: cache stability', () => {
  const baseCtx = {
    cwd: '/test',
    gitStatus: 'Current branch: main\nStatus:\nM src/foo.ts',
    rivetMd: '# Project\nTest project',
    workingSet: ['src/foo.ts'],
  }

  it('FROZEN includes git-status section', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    assert.ok(frozen.includes('<git-status>'), 'FROZEN must contain <git-status>')
    assert.ok(frozen.includes('M src/foo.ts'))
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

  it('FRESH equals FROZEN when dynamic fields are empty', () => {
    const frozen = buildStableVolatileBlock(baseCtx)
    const fresh = buildLatestTurnVolatileBlock(baseCtx)
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

  it('dynamic appendix is empty string when no dynamic fields', () => {
    const appendix = buildDynamicAppendix(baseCtx)
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

  it('volatile block before "hello" is identical in Turn 1 and Turn 2 requests', () => {
    const engine = createEngine()

    // Turn 1: just user says "hello"
    const req1 = engine.buildRequest([
      { role: 'user', content: 'hello' },
    ])

    // Turn 2: history + new message
    const req2 = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi there' },
      { role: 'user', content: 'read file' },
    ], [{ tool: 'read_file', target: 'src/foo.ts', status: 'success' }])

    // messages[0] is the volatile block before "hello"
    const vol1 = (req1.messages[0] as { content: string }).content
    const vol2 = (req2.messages[0] as { content: string }).content
    assert.equal(vol1, vol2, 'Volatile block for "hello" must be byte-identical across turns')
  })

  it('volatile block for historical turns stays frozen across 5 turns', () => {
    const engine = createEngine()
    const volatileBlocks: string[] = []

    for (let turn = 1; turn <= 5; turn++) {
      const messages: Message[] = []
      for (let t = 1; t <= turn; t++) {
        messages.push({ role: 'user', content: `message ${t}` })
        if (t < turn) {
          messages.push({ role: 'assistant', content: `response ${t}` })
        }
      }

      const toolHistory = turn > 1
        ? [{ tool: 'read_file', target: `file${turn}.ts`, status: 'success' as const }]
        : undefined

      const req = engine.buildRequest(messages, toolHistory)

      // The volatile block before the FIRST user message (messages[0])
      const firstVol = (req.messages[0] as { content: string }).content
      volatileBlocks.push(firstVol)
    }

    // ALL volatile blocks for the first user message must be identical
    for (let i = 1; i < volatileBlocks.length; i++) {
      assert.equal(volatileBlocks[i], volatileBlocks[0],
        `Turn ${i + 1}: volatile block for first message must match Turn 1`)
    }
  })

  it('FRESH volatile for latest turn starts with FROZEN content', () => {
    const engine = createEngine()

    const req = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read file' },
    ], [{ tool: 'read_file', target: 'x', status: 'success' }])

    // messages[0] = FROZEN volatile for "hello"
    const frozenVol = (req.messages[0] as { content: string }).content

    // Find the FRESH volatile - it's the message before the last user text
    let freshVol = ''
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const msg = req.messages[i] as { role: string; content: string }
      if (msg.role === 'user' && msg.content === 'read file') {
        freshVol = (req.messages[i - 1] as { content: string }).content
        break
      }
    }

    assert.ok(freshVol.startsWith(frozenVol),
      'FRESH volatile must start with exact FROZEN bytes')
  })

  it('system prompt is identical across turns', () => {
    const engine = createEngine()

    const req1 = engine.buildRequest([
      { role: 'user', content: 'hello' },
    ])
    const req2 = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read' },
    ])

    assert.equal(req1.system, req2.system, 'System prompt must be identical across turns')
  })
})
