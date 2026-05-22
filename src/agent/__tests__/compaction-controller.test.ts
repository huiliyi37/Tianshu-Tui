import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'

function makeEngine(): PromptEngine {
  return new PromptEngine({
    model: 'test-model',
    maxTokens: 1024,
    staticCtx: { tools: [] },
    volatileCtx: { cwd: '/test' },
  })
}

function makeController(session: SessionContext, overrides: Partial<ConstructorParameters<typeof CompactionController>[0]> = {}): CompactionController {
  return new CompactionController({
    session,
    promptEngine: makeEngine(),
    contextWindow: 128_000,
    pressureMonitor: new PressureMonitor(128_000),
    getTrajectoryEntries: () => [],
    getStreamedText: () => '',
    refreshLedger: () => {},
    ...overrides,
  })
}

describe('CompactionController', () => {
  it('runs micro compact when pressure crosses ratio threshold', async () => {
    const session = new SessionContext()
    const historyMessage = 'x'.repeat(12_000 * 4)
    session.replaceMessages([
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
      { role: 'user', content: historyMessage },
      { role: 'assistant', content: historyMessage },
    ])
    let refreshed = false
    const controller = makeController(session, {
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, true)
    assert.deepEqual(result.failures, { consecutiveFailures: 0 })
    assert.equal(refreshed, true)
    assert.equal(session.wasCompactedAt(0), true)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 1)
    assert.ok(session.getEstimatedTokens() < 96_000 || session.getMessages().length <= 8)
  })

  it('falls back to cache anchors plus resume state when over the hard ceiling', () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(80_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    let refreshed = false
    const controller = makeController(session, {
      getTrajectoryEntries: () => [{
        turn: 1,
        tool: 'read_file',
        target: 'src/a.ts',
        status: 'success',
        durationMs: 1,
        inputSummary: 'src/a.ts',
        resultSummary: 'read src/a.ts',
      }],
      getStreamedText: () => 'Remaining: finish implementation',
      refreshLedger: () => { refreshed = true },
    })

    controller.enforceContextCeiling()

    const messages = session.getMessages()
    assert.equal(messages[0]?.content, 'anchor user')
    assert.equal(messages[1]?.content, 'anchor assistant')
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.ok(session.getEstimatedTokens() <= 128_000 * 0.95)
    assert.equal(refreshed, true)
    assert.equal(session.getCompactEvents().at(-1)?.tier, 4)
  })

  it('returns a cache diagnostic only for low latest-turn hit rate', () => {
    const session = new SessionContext()
    const controller = makeController(session)

    assert.equal(controller.refreshCacheDiagnostic(1), null)

    session.recordTurnCache(1, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 10,
      cache_creation_input_tokens: 90,
    })

    assert.match(controller.refreshCacheDiagnostic(1) ?? '', /cache/i)

    session.recordTurnCache(2, {
      input_tokens: 100,
      output_tokens: 10,
      cache_read_input_tokens: 99,
      cache_creation_input_tokens: 1,
    })

    assert.equal(controller.refreshCacheDiagnostic(2), null)
  })
})
