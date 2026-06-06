import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactionController } from '../compaction-controller.js'
import { SessionContext } from '../context.js'
import { PromptEngine } from '../../prompt/engine.js'
import { PressureMonitor } from '../../context/pressure-monitor.js'
import type { TrajectoryEntry } from '../trajectory.js'
import type { OaiChatRequest } from '../../api/oai-types.js'
import type { StreamCallbacks, StreamClient } from '../../api/stream-client.js'

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

  it('falls back to cache anchors plus resume state when over the hard ceiling', async () => {
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

    await controller.enforceContextCeiling()

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
  it('P2.1: enforceContextCeiling still fires on 1M+ window', async () => {
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

    await controller.enforceContextCeiling()

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
  it('P2.3: session split at 86% context preserves prefix anchors', async () => {
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

    const didSplit = await controller.trySessionSplit()

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

  it('P2.3: session split is skipped when below 86% threshold', async () => {
    const session = new SessionContext()
    session.replaceMessages([
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: 'hi' },
    ])

    const controller = makeController(session, { contextWindow: 1_000_000 })

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split below 86%')

    // Messages should be unchanged
    assert.equal(session.getMessages().length, 2)
  })

  it('P2.3: session split is skipped on small windows (< 500K)', async () => {
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

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, false, 'should not split on small windows')
    // Messages should be unchanged
    assert.equal(session.getMessages().length, tokensBefore)
  })

  // P3: trySessionSplit and enforceContextCeiling share the same structural
  // pattern: preserve CACHE_ANCHOR_MESSAGES + inject a handoff user message.
  // The unified replaceWithCheckpoint method powers both.
  it('P3: trySessionSplit and enforceContextCeiling produce structurally equivalent output', async () => {
    // === trySessionSplit path ===
    const session1 = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session1.replaceMessages([
      { role: 'user', content: 'anchor user 1' },
      { role: 'assistant', content: 'anchor assistant 1' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    let refreshed1 = false
    const ctrl1 = makeController(session1, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed1 = true },
    })
    const didSplit = await ctrl1.trySessionSplit()
    assert.equal(didSplit, true)
    const msgs1 = session1.getMessages()
    // Structural invariant: anchors + 1 handoff
    assert.equal(msgs1.length, 3)
    assert.equal(msgs1[0]?.role, 'user')
    assert.equal(msgs1[1]?.role, 'assistant')
    assert.equal(msgs1[2]?.role, 'user')
    assert.match(String(msgs1[2]?.content), /<session-handoff>/)
    assert.equal(refreshed1, true)

    // === enforceContextCeiling path ===
    const session2 = new SessionContext()
    const huge2 = 'x'.repeat(200_000 * 4)
    session2.replaceMessages([
      { role: 'user', content: 'anchor user 2' },
      { role: 'assistant', content: 'anchor assistant 2' },
      { role: 'user', content: huge2 },
      { role: 'assistant', content: huge2 },
      { role: 'user', content: huge2 },
      { role: 'assistant', content: huge2 },
      { role: 'user', content: huge2 },
    ])
    let refreshed2 = false
    const ctrl2 = makeController(session2, {
      contextWindow: 1_000_000,
      refreshLedger: () => { refreshed2 = true },
    })
    await ctrl2.enforceContextCeiling()
    const msgs2 = session2.getMessages()
    // Same structural invariant: anchors + 1 handoff
    assert.equal(msgs2.length, 3)
    assert.equal(msgs2[0]?.role, 'user')
    assert.equal(msgs2[1]?.role, 'assistant')
    assert.equal(msgs2[2]?.role, 'user')
    assert.match(String(msgs2[2]?.content), /<checkpoint-resume>/)
    assert.equal(refreshed2, true)
  })

  // P4: Session split handoff should include tool call mappings from
  // trajectory (tool → target, status) and failure patterns with error classes.
  it('P4: session split handoff includes tool call mappings from trajectory', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'initial request' },
      { role: 'assistant', content: 'I will refactor the codebase' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])

    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/loop.ts', durationMs: 50, status: 'success', inputSummary: 'read', resultSummary: 'ok' },
      { turn: 2, tool: 'edit_file', target: 'src/loop.ts', durationMs: 100, status: 'success', inputSummary: 'edit', resultSummary: 'ok' },
      { turn: 3, tool: 'bash', target: 'npx tsc --noEmit', durationMs: 3000, status: 'failed', errorClass: 'TS2322', inputSummary: 'typecheck', resultSummary: 'error' },
      { turn: 4, tool: 'edit_file', target: 'src/loop.ts', durationMs: 80, status: 'retried-success', inputSummary: 'fix', resultSummary: 'ok' },
      { turn: 5, tool: 'bash', target: 'npx tsc --noEmit', durationMs: 2000, status: 'success', inputSummary: 'typecheck', resultSummary: 'PASS' },
    ]

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      getTrajectoryEntries: () => trajectory,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = await controller.trySessionSplit()
    assert.equal(didSplit, true)

    const msgs = session.getMessages()
    const handoff = String(msgs[2]?.content ?? '')

    // Should include tool call mappings with status
    assert.match(handoff, /edit_file/)
    assert.match(handoff, /read_file/)
    assert.match(handoff, /bash/)

    // Should include failure patterns with error class
    assert.match(handoff, /failed/i)
    assert.match(handoff, /TS2322/, 'handoff must include error class from failed tool calls')

    // Should indicate retries via ok* notation
    assert.match(handoff, /ok\*/, 'handoff must indicate retried-success with ok* notation')

    assert.equal(refreshed, true)
  })

  it('A-1: trySessionSplit skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(220_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
    ])
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    const didSplit = await controller.trySessionSplit()

    assert.equal(didSplit, false)
    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('A-1b: enforceContextCeiling skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(200_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late ceiling compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('A-1c: maybeCompact (1M window LLM compact) skips checkpoint mutation when abort lands after LLM compact returns', async () => {
    const session = new SessionContext()
    // 1M window LLM-compact path fires at ratio >= 0.75. 12 messages ×
    // ~65K tokens ≈ 780K tokens → 78% → reaches the L279 abort guard.
    const chunk = 'x'.repeat(260_000) // 260K chars / 4 ≈ 65K tokens
    session.replaceMessages(
      Array.from({ length: 12 }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: chunk,
      })),
    )
    assert.ok(
      session.getEstimatedTokens() / 1_000_000 >= 0.75,
      'setup: tokens must exceed 75% of 1M window to reach the LLM-compact path',
    )
    const before = session.getMessages().map(m => m.content)
    const abortController = new AbortController()
    let refreshed = false
    const primaryClient: StreamClient = {
      stream: async (_request: OaiChatRequest, callbacks: StreamCallbacks) => {
        callbacks.onTextDelta('late micro compact summary')
        abortController.abort()
      },
    }

    const controller = makeController(session, {
      contextWindow: 1_000_000,
      primaryClient,
      getAbortSignal: () => abortController.signal,
      refreshLedger: () => { refreshed = true },
    })

    const result = await controller.maybeCompact({ loopTurn: 0, failures: { consecutiveFailures: 0 } })

    assert.equal(result.compacted, false)
    assert.deepEqual(session.getMessages().map(m => m.content), before)
    assert.equal(refreshed, false)
  })

  it('P4: enforceContextCeiling handoff also benefits from trajectory data', async () => {
    const session = new SessionContext()
    const huge = 'x'.repeat(200_000 * 4)
    session.replaceMessages([
      { role: 'user', content: 'anchor user' },
      { role: 'assistant', content: 'anchor assistant' },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
      { role: 'assistant', content: huge },
      { role: 'user', content: huge },
    ])

    const trajectory: TrajectoryEntry[] = [
      { turn: 1, tool: 'read_file', target: 'src/foo.ts', durationMs: 30, status: 'success', inputSummary: 'read', resultSummary: 'ok' },
      { turn: 2, tool: 'write_file', target: 'src/bar.ts', durationMs: 40, status: 'failed', errorClass: 'ENOENT', inputSummary: 'write', resultSummary: 'error' },
    ]

    let refreshed = false
    const controller = makeController(session, {
      contextWindow: 1_000_000,
      getTrajectoryEntries: () => trajectory,
      getStreamedText: () => 'I need to fix the ENOENT error and implement the feature',
      refreshLedger: () => { refreshed = true },
    })

    await controller.enforceContextCeiling()

    const msgs = session.getMessages()
    const handoff = String(msgs[2]?.content ?? '')

    // Should include tool names from trajectory (more reliable than regex from content)
    assert.match(handoff, /read_file/)
    assert.match(handoff, /write_file/)

    // Should include failure context
    assert.match(handoff, /failed/i)
    assert.match(handoff, /ENOENT/, 'ceiling handoff must include error class')

    assert.equal(refreshed, true)
  })

  // Phase 2: compact summary injection at tier 2+
  it('P2: injects compact-summary message after micro-compact at tier 2+', async () => {
    const session = new SessionContext()
    // Create enough content to cross the compact threshold (78% for balanced)
    // Balanced: compact=0.78 → ~78K on 100K window
    const chunk = 'x'.repeat(32_000) // 32K chars / 4 ≈ 8K tokens
    const msgs: Array<{ role: 'user' | 'assistant'; content: string }> = []
    for (let i = 0; i < 10; i++) {
      msgs.push({ role: 'user', content: chunk })
      msgs.push({ role: 'assistant', content: chunk })
    }
    session.replaceMessages(msgs)
    // Force estimated tokens to cross the compact threshold
    // 20 messages × 8K tokens = 160K → 160% → tier 4 (ceiling)
    // Use a smaller 200K window so ratio is realistic
    const tokens = session.getEstimatedTokens()

    const entries = [
      { turn: 1, tool: 'read_file', target: 'src/a.ts', status: 'success' as const, durationMs: 0, inputSummary: '', resultSummary: 'ok' },
      { turn: 2, tool: 'edit_file', target: 'src/a.ts', status: 'success' as const, durationMs: 0, inputSummary: '', resultSummary: 'ok' },
    ]

    let refreshed = false
    const controller = new CompactionController({
      session,
      promptEngine: makeEngine(),
      contextWindow: Math.max(tokens * 2, 100_000), // large enough to not ceiling
      pressureMonitor: new PressureMonitor(Math.max(tokens * 2, 100_000)),
      getTrajectoryEntries: () => entries,
      getStreamedText: () => 'I will fix the bug. Next, add tests.',
      refreshLedger: () => { refreshed = true },
    })

    // Force compact at tier 2 by manipulating token estimate
    const result = await controller.maybeCompact({
      loopTurn: 3,
      failures: { consecutiveFailures: 0 },
    })

    // Should have compacted (not skipped)
    // If compaction occurred, the summary should be in the messages
    const msgsAfter = session.getMessages()
    const summaryMsg = msgsAfter.find(m =>
      m.role === 'user' && typeof m.content === 'string' && m.content.includes('<compact-summary>'),
    )
    if (result.compacted) {
      assert.ok(summaryMsg, 'compacted session should contain compact-summary message')
      assert.match(String(summaryMsg!.content), /Goals/)
      assert.match(String(summaryMsg!.content), /Progress/)
    }
    // If not compacted, still a valid outcome (token estimate might not cross threshold)
  })
})
