import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController, type CompactionControllerDeps } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import { CACHE_ANCHOR_MESSAGES } from '../../compact/constants.js'

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
