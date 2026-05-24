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

  // P1.2: prune should NOT mutate session storage
  it('P1.2: prune does NOT modify session message storage', async () => {
    const session = new SessionContext()
    // Build messages with several large-enough tool results to trigger prune.
    // On 128K contextWindow, prune.minChars=40_000. Each tool result is 50K →
    // exceeds minChars. With protectRecent=8 and CACHE_ANCHOR_MESSAGES=2,
    // tool results at indices 2-7 (before recent 8) should be pruned.
    const messages: Array<{ role: 'user' | 'assistant' | 'tool'; content: string; tool_call_id?: string }> = [
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ]
    // Add tool results that trigger prune
    for (let i = 0; i < 12; i++) {
      messages.push({
        role: 'tool',
        content: 'x'.repeat(50_000),
        tool_call_id: `tc_${i}`,
      })
    }
    // Add recent messages (within protectRecent) — won't be pruned
    messages.push({ role: 'user', content: 'recent query' })
    messages.push({ role: 'assistant', content: 'recent answer' })

    session.replaceMessages(messages as any)
    const messagesBefore = session.getMessages()
    const contentsBefore = messagesBefore.map(m => m.content)

    const controller = makeController(session, { contextWindow: 128_000 })

    const result = await controller.maybeCompact({
      loopTurn: 1,
      failures: { consecutiveFailures: 0 },
    })

    const messagesAfter = session.getMessages()
    const contentsAfter = messagesAfter.map(m => m.content)

    // Messages in storage must be unchanged — prune is now request-time mask
    assert.deepStrictEqual(
      contentsAfter,
      contentsBefore,
      'prune must not mutate session message storage'
    )
  })

  // Phase 2.1: On 1M+ windows, skip microCompactOai to preserve exact prefix cache.
  // The 1M window has enough headroom — enforceContextCeiling (95%) remains as
  // emergency last resort, but regular compaction is permanently disabled.
  it('P2.1: skips compaction on 1M+ context window even when thresholds are crossed', async () => {
    const session = new SessionContext()
    // Create enough content to cross the 60% watch threshold on a 1M window.
    // Balanced strategy: watch=0.60 → need 600K+ tokens.
    // 10 messages × 65K tokens each = 650K tokens → 65% ratio → should trigger.
    const chunk = 'x'.repeat(260_000) // 260K chars / 4 ≈ 65K tokens
    const msgs = [
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
      { role: 'user' as const, content: chunk },
      { role: 'assistant' as const, content: chunk },
    ]
    session.replaceMessages(msgs)
    const tokensBefore = session.getEstimatedTokens()
    const messagesBefore = session.getMessages()

    // Ratio check: must actually cross the threshold
    assert.ok(
      tokensBefore / 1_000_000 >= 0.60,
      `setup: tokens ${tokensBefore} must exceed 60% of 1M window`
    )

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({
      loopTurn: 0,
      failures: { consecutiveFailures: 0 },
    })

    // Core assertion: compaction must not happen on 1M+ window
    assert.equal(result.compacted, false, 'must not compact on 1M+ window')
    assert.deepEqual(result.failures, { consecutiveFailures: 0 })
    assert.equal(refreshed, false)

    // Storage must be untouched
    const messagesAfter = session.getMessages()
    assert.deepStrictEqual(
      messagesAfter.map(m => m.content),
      messagesBefore.map(m => m.content),
      'messages must be unchanged when compaction is skipped'
    )
  })

  // Phase 2.1: enforceContextCeiling MUST still fire on 1M+ windows.
  // The 95% ceiling is the emergency last resort — if we're truly about to
  // overflow, we checkpoint-resume regardless of cache implications.
  it('P2.1: enforceContextCeiling still fires on 1M+ window', () => {
    const session = new SessionContext()
    // Create enough to exceed 95% of 1M window = 950K tokens.
    // Each huge message: 200K * 4 chars = 200K tokens. 5 messages = 1M tokens.
    const huge = 'x'.repeat(200_000 * 4) // 200K tokens per message
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed = true },
    })

    controller.enforceContextCeiling()

    const messages = session.getMessages()
    // Ceiling still fired: only 2 anchor messages + checkpoint-resume remain
    assert.equal(messages.length, 3)
    assert.match(String(messages[2]?.content), /<checkpoint-resume>/)
    assert.ok(session.getEstimatedTokens() <= 1_000_000 * 0.95)
    assert.equal(refreshed, true)
  })

  // Phase 2.3: Session split at 86% context proactively replaces message
  // history with cache anchors + handoff summary. Preserves exact prefix
  // (system+tools+2 anchors) for DeepSeek disk cache hits.
  it('P2.3: session split at 86% context preserves prefix anchors', () => {
    const session = new SessionContext()
    // Create enough content to cross 86% of 1M window = 860K tokens
    const huge = 'x'.repeat(220_000 * 4) // 220K tokens per message
    session.replaceMessages([
      { role: 'user', content: 'initial request about refactoring loop.ts' },
      { role: 'assistant', content: 'I will analyze the file structure first' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])

    const messagesBefore = session.getMessages()
    const tokensBefore = session.getEstimatedTokens()
    assert.ok(
      tokensBefore / 1_000_000 >= 0.86,
      `setup: tokens ${tokensBefore} must exceed 86% of 1M window`
    )

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = controller.trySessionSplit()

    assert.equal(didSplit, true, 'session split should occur at 86%')

    const messagesAfter = session.getMessages()
    // After split: 2 anchor messages + 1 handoff user message = 3
    assert.equal(messagesAfter.length, 3, 'should have 2 anchors + 1 handoff')
    // First two messages (anchors) must be identical to original
    assert.deepStrictEqual(messagesAfter[0], messagesBefore[0], 'first anchor preserved')
    assert.deepStrictEqual(messagesAfter[1], messagesBefore[1], 'second anchor preserved')
    // Handoff message must be a user message
    assert.equal(messagesAfter[2]?.role, 'user', 'handoff must be user message')
    assert.match(
      String(messagesAfter[2]?.content),
      /<session-handoff>/,
      'handoff must have session-handoff marker'
    )
    // Token count must be well under the window
    assert.ok(session.getEstimatedTokens() <= 1_000_000 * 0.3, 'post-split tokens must be small')
    assert.equal(refreshed, true)
  })

  it('P2.3: session split is skipped when below 86% threshold', () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])

    const controller = makeController(session, { contextWindow: 1_000_000 })

    const didSplit = controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split below 86%')

    // Messages should be unchanged
    assert.equal(session.getMessages().length, 2)
  })

  it('P2.3: session split is skipped on small windows (< 500K)', () => {
    const session = new SessionContext()
    // Fill to nearly the window size (but under 500K window)
    const chunk = 'x'.repeat(50_000)
    const msgs = []
    for (let i = 0; i < 8; i++) {
      msgs.push({ role: 'user' as const, content: chunk })
      msgs.push({ role: 'assistant' as const, content: chunk })
    }
    session.replaceMessages(msgs)

    const tokensBefore = session.getMessages().length
    const controller = makeController(session, { contextWindow: 128_000 })

    const didSplit = controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split on small windows')
    // Messages should be unchanged
    assert.equal(session.getMessages().length, tokensBefore)
  })
})
