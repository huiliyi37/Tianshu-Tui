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

    // 3 turns + 1 check = 4 recordTurn calls, below threshold of 5
    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildRequest([{ role: 'user', content: 'check' }])
    const vol = (req.messages[0] as { content: string }).content
    assert.ok(!vol.includes('<consolidated>'), 'No consolidated block before threshold')
  })

  it('consolidated block appears after threshold turns with stable domain', () => {
    const engine = createEngineH(3) // lower threshold for test speed

    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      const messages: Message[] = []
      for (let m = 0; m <= t; m++) {
        messages.push({ role: 'user', content: `msg ${m}` })
        if (m < t) messages.push({ role: 'assistant', content: `resp ${m}` })
      }
      engine.buildRequest(messages)
    }

    const messages: Message[] = [{ role: 'user', content: 'final' }]
    const req = engine.buildRequest(messages)
    const vol = (req.messages[0] as { content: string }).content
    assert.ok(vol.includes('<consolidated>'), 'Consolidated block should appear after threshold')
    assert.ok(vol.includes('tianshu'), 'Consolidated should contain domain name')
  })

  it('historical volatile includes consolidated block after promotion', () => {
    const engine = createEngineH(3)

    // Promote domain over 3 turns
    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    // Now build a multi-turn request — historical volatile should include consolidated
    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildRequest([
      { role: 'user', content: 'msg 0' },
      { role: 'assistant', content: 'resp 0' },
      { role: 'user', content: 'msg 1' },
    ])

    const histVol = (req.messages[0] as { content: string }).content
    assert.ok(histVol.includes('<consolidated>'), 'Historical volatile must include consolidated')
  })

  it('dehabituation removes field from consolidated block', () => {
    const engine = createEngineH(3)

    // Promote
    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    // Verify promoted
    let req = engine.buildRequest([{ role: 'user', content: 'check' }])
    let vol = (req.messages[0] as { content: string }).content
    assert.ok(vol.includes('<consolidated>'))

    // Change domain → dehabituation
    engine.setActiveDomain({ name: 'tianji', volatileBlock: 'other', motto: 'other-motto' })
    req = engine.buildRequest([{ role: 'user', content: 'after change' }])
    vol = (req.messages[0] as { content: string }).content
    assert.ok(!vol.includes('<consolidated>'), 'Consolidated should disappear after dehabituation')
  })

  it('FROZEN+CONSOLIDATED is byte prefix of FRESH with active appendix', () => {
    const engine = createEngineH(3)

    // Promote domain
    for (let t = 0; t < 3; t++) {
      engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    // Build with active dynamic fields
    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'block', motto: 'motto' })
    const req = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
      { role: 'user', content: 'read' },
    ], [{ tool: 'read_file', target: 'x', status: 'success' }])

    const histVol = (req.messages[0] as { content: string }).content  // FROZEN+CONSOLIDATED

    // Find FRESH volatile (before last user text "read")
    let freshVol = ''
    for (let i = req.messages.length - 1; i >= 0; i--) {
      const m = req.messages[i] as { role: string; content: string }
      if (m.role === 'user' && m.content === 'read') {
        freshVol = (req.messages[i - 1] as { content: string }).content
        break
      }
    }

    assert.ok(freshVol.startsWith(histVol),
      'FRESH must start with FROZEN+CONSOLIDATED bytes')
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
      engine.buildRequest([{ role: 'user', content: `msg ${t}` }])
    }

    const req = engine.buildRequest([{ role: 'user', content: 'test' }])
    const vol = (req.messages[0] as { content: string }).content
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

    // Simulate agent loop: 1 user message, 5 tool-call turns
    for (let turn = 0; turn < 5; turn++) {
      const messages: Message[] = [
        { role: 'user', content: 'refactor the auth module' },
      ]
      // Add accumulated tool_use/tool_result pairs
      for (let t = 0; t < turn; t++) {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `call_${t}`, name: 'read_file', input: { path: `file${t}.ts` } }] as any })
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `call_${t}`, content: `content of file${t}` }] as any })
      }

      const toolHistory = turn > 0
        ? [{ tool: 'read_file', target: `file${turn - 1}.ts`, status: 'success' as const }]
        : undefined

      const req = engine.buildRequest(messages, toolHistory)
      // First message is always the volatile block
      volatileBlocks.push((req.messages[0] as { content: string }).content)
    }

    // ALL volatile blocks must be byte-identical (cached from first call)
    for (let i = 1; i < volatileBlocks.length; i++) {
      assert.equal(volatileBlocks[i], volatileBlocks[0],
        `Turn ${i}: volatile block must be identical to Turn 0 (same user message → cached)`)
    }
  })

  it('volatile block regenerates when a NEW user message arrives', () => {
    const engine = createEngine()

    // Turn 1: user message "hello"
    const req1 = engine.buildRequest([
      { role: 'user', content: 'hello' },
    ])
    const vol1 = (req1.messages[0] as { content: string }).content

    // Turn 2: same user message + tool result → cached, same volatile
    const req2 = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'tool_use', id: 'c1', name: 'bash', input: { command: 'ls' } }] as any },
      { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file1\nfile2' }] as any },
    ])
    const vol2 = (req2.messages[0] as { content: string }).content
    assert.equal(vol1, vol2, 'Same user message → cached volatile')

    // Turn 3: NEW user message "read file" → volatile regenerated
    engine.setBehaviorMirror('some new mirror')
    const req3 = engine.buildRequest([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'done' },
      { role: 'user', content: 'read file' },
    ])
    // Historical "hello" gets FROZEN
    const histVol = (req3.messages[0] as { content: string }).content
    // "read file" gets new FRESH (with behaviorMirror)
    let freshVol = ''
    for (let i = req3.messages.length - 1; i >= 0; i--) {
      const m = req3.messages[i] as { role: string; content: string }
      if (m.role === 'user' && m.content === 'read file') {
        freshVol = (req3.messages[i - 1] as { content: string }).content
        break
      }
    }
    assert.notEqual(freshVol, vol1, 'New user message → regenerated volatile')
  })

  it('10 tool-call turns: volatile block never changes', () => {
    const engine = createEngine()
    engine.setActiveDomain({ name: 'tianshu', volatileBlock: 'b', motto: 'm' })

    let firstVol = ''
    for (let turn = 0; turn < 10; turn++) {
      const messages: Message[] = [
        { role: 'user', content: 'implement feature X' },
      ]
      for (let t = 0; t < turn; t++) {
        messages.push({ role: 'assistant', content: [{ type: 'tool_use', id: `c_${t}`, name: 'edit_file', input: {} }] as any })
        messages.push({ role: 'user', content: [{ type: 'tool_result', tool_use_id: `c_${t}`, content: 'ok' }] as any })
      }

      const req = engine.buildRequest(messages, [
        { tool: 'edit_file', target: `file${turn}.ts`, status: 'success' },
      ])
      const vol = (req.messages[0] as { content: string }).content

      if (turn === 0) firstVol = vol
      else assert.equal(vol, firstVol, `Turn ${turn}: volatile must match Turn 0`)
    }
  })
})
