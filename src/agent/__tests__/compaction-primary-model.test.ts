import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController, type CompactionControllerDeps } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import { CACHE_ANCHOR_MESSAGES, summaryOutputBudgetChars } from '../../compact/constants.js'

function createDeps(overrides: Partial<CompactionControllerDeps> = {}): CompactionControllerDeps {
  const session = new SessionContext()
  return {
    session,
    promptEngine: new PromptEngine({
      model: 'test-model',
      maxTokens: 4096,
      staticCtx: { tools: [] },
      volatileCtx: { cwd: '/test' },
    }),
    contextWindow: 1_000_000,
    pressureMonitor: new PressureMonitor(1_000_000),
    getTrajectoryEntries: () => [],
    getStreamedText: () => '',
    refreshLedger: () => {},
    ...overrides,
  }
}

describe('CompactionController llmCompact (Forked Agent)', () => {
  it('returns summary string when primaryClient is available', async () => {
    const deps = createDeps({
      primaryClient: {
        stream: async (_req: any, callbacks: any) => {
          callbacks.onTextDelta('Summary: test completed successfully.')
        },
      } as any,
    })

    const controller = new CompactionController(deps)

    // Populate session with enough messages
    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'hi there' }])
    deps.session.addUserMessage('do task')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'doing task...' }])

    const summary = await controller.llmCompact()
    assert.ok(typeof summary === 'string', 'should return string summary')
    assert.ok(summary.includes('Summary'), 'should contain the mock response')
  })

  it('returns null when session has insufficient messages', async () => {
    const deps = createDeps({
      primaryClient: {
        stream: async () => {},
      } as any,
    })

    const controller = new CompactionController(deps)
    // Only 1 message — below CACHE_ANCHOR_MESSAGES + 2 threshold
    deps.session.addUserMessage('hello')

    const result = await controller.llmCompact()
    assert.equal(result, null, 'should return null for insufficient messages')
  })

  it('returns null when primaryClient is not available', async () => {
    const deps = createDeps() // no primaryClient
    const controller = new CompactionController(deps)

    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'hi' }])
    deps.session.addUserMessage('more')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'more' }])

    const result = await controller.llmCompact()
    assert.equal(result, null, 'should return null when primaryClient is unavailable')
  })

  it('returns null when stream throws an error', async () => {
    const deps = createDeps({
      primaryClient: {
        stream: async () => { throw new Error('network error') },
      } as any,
    })

    const controller = new CompactionController(deps)
    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'hi' }])
    deps.session.addUserMessage('more')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'more' }])

    const result = await controller.llmCompact()
    assert.equal(result, null, 'should return null on stream error')
  })
})

describe('CompactionController compactClient routing', () => {
  const seed = (deps: CompactionControllerDeps) => {
    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'hi there' }])
    deps.session.addUserMessage('do task')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'doing task...' }])
  }

  it('uses compactClient (not primaryClient) when both are set', async () => {
    let primaryCalled = false
    let compactCalled = false
    const deps = createDeps({
      primaryClient: { stream: async (_r: any, cb: any) => { primaryCalled = true; cb.onTextDelta('primary') } } as any,
      compactClient: { stream: async (_r: any, cb: any) => { compactCalled = true; cb.onTextDelta('compact summary') } } as any,
    })
    const controller = new CompactionController(deps)
    seed(deps)

    const summary = await controller.llmCompact()
    assert.equal(compactCalled, true, 'compactClient must be used')
    assert.equal(primaryCalled, false, 'primaryClient must NOT be touched')
    assert.ok(summary?.includes('compact summary'))
  })

  it('falls back to primaryClient when compactClient is absent', async () => {
    let primaryCalled = false
    const deps = createDeps({
      primaryClient: { stream: async (_r: any, cb: any) => { primaryCalled = true; cb.onTextDelta('primary summary') } } as any,
    })
    const controller = new CompactionController(deps)
    seed(deps)

    const summary = await controller.llmCompact()
    assert.equal(primaryCalled, true)
    assert.ok(summary?.includes('primary summary'))
  })

  it('works with only compactClient (no primaryClient)', async () => {
    const deps = createDeps({
      compactClient: { stream: async (_r: any, cb: any) => { cb.onTextDelta('only compact') } } as any,
    })
    const controller = new CompactionController(deps)
    seed(deps)

    const summary = await controller.llmCompact()
    assert.ok(summary?.includes('only compact'))
  })

  it('uses a generous (≈2×) summary budget when compactClient is set', async () => {
    let prompt = ''
    const capture = (_r: any, cb: any) => {
      prompt = JSON.stringify(_r)
      cb.onTextDelta('s')
    }
    // 1M window → base full=8000, generous full=16000.
    const generousDeps = createDeps({
      contextWindow: 1_000_000,
      compactClient: { stream: capture } as any,
    })
    seed(generousDeps)
    await new CompactionController(generousDeps).llmCompact()
    assert.ok(prompt.includes(String(summaryOutputBudgetChars(1_000_000, { generous: true }).full)), 'generous budget (16000) must be in the prompt')

    prompt = ''
    const plainDeps = createDeps({
      contextWindow: 1_000_000,
      primaryClient: { stream: capture } as any,
    })
    seed(plainDeps)
    await new CompactionController(plainDeps).llmCompact()
    assert.ok(prompt.includes(String(summaryOutputBudgetChars(1_000_000).full)), 'base budget (8000) must be in the prompt when no compactClient')
  })
})

describe('CompactionController iterative summary merge', () => {
  const capturePrompt = () => {
    let prompt = ''
    const client = { stream: async (_r: any, cb: any) => { prompt = JSON.stringify(_r); cb.onTextDelta('s') } } as any
    return { client, get: () => prompt }
  }

  it('injects the merge clause when a prior summary exists in history', async () => {
    const cap = capturePrompt()
    const deps = createDeps({ primaryClient: cap.client })
    const controller = new CompactionController(deps)
    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: '<partial-compact-summary turn="1">earlier work</partial-compact-summary>' }])
    deps.session.addUserMessage('next task')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'working' }])

    await controller.llmCompact()
    assert.ok(cap.get().includes('迭代合并'), 'merge clause must be present when a prior summary exists')
  })

  it('omits the merge clause on a first (clean) compaction', async () => {
    const cap = capturePrompt()
    const deps = createDeps({ primaryClient: cap.client })
    const controller = new CompactionController(deps)
    deps.session.addUserMessage('hello')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'hi there' }])
    deps.session.addUserMessage('do task')
    deps.session.addAssistantBlocks([{ type: 'text', text: 'doing task' }])

    await controller.llmCompact()
    assert.ok(!cap.get().includes('迭代合并'), 'merge clause must be absent on first compaction')
  })
})

describe('summaryOutputBudgetChars', () => {
  it('doubles budgets in generous mode across window tiers', () => {
    for (const w of [100_000, 500_000, 1_000_000]) {
      const base = summaryOutputBudgetChars(w)
      const generous = summaryOutputBudgetChars(w, { generous: true })
      assert.equal(generous.full, base.full * 2)
      assert.equal(generous.partial, base.partial * 2)
    }
  })
})
