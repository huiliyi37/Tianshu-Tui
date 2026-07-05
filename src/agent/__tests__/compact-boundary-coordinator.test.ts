import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { CompactBoundaryCoordinator, type CompactBoundaryDeps } from '../compact-boundary-coordinator.js'
import type { CompactCircuitBreakerState } from '../../context/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

/**
 * C-line: CompactBoundaryCoordinator is the extracted compaction-boundary brain
 * of the loop and shipped with no dedicated tests. The riskiest invariant it
 * guards is P2-5: history-rewriting compaction must only happen at user
 * boundaries (turn 0) — off-boundary rewrites shatter the prefix cache. These
 * tests lock that, plus abort short-circuiting and the compaction-failure
 * immune signal.
 */

interface Calls {
  maybeCompact: number
  replaceMessages: number
  immuneSignals: Array<{ kind: string; severity: number; turn: number; source: string }>
  pendingStaleCompact: boolean
  pendingHeapCompact: boolean
  lastCompactTurn: number | null
  setFailures: CompactCircuitBreakerState | null
}

function bigMsgs(n: number, charsEach = 200): OaiMessage[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? 'user' : 'assistant',
    content: 'x'.repeat(charsEach),
  })) as OaiMessage[]
}

function makeCoord(overrides: Partial<CompactBoundaryDeps> & {
  aborted?: boolean
  failures?: CompactCircuitBreakerState
  splitConsumes?: boolean
  compacted?: boolean
} = {}) {
  const calls: Calls = {
    maybeCompact: 0,
    replaceMessages: 0,
    immuneSignals: [],
    pendingStaleCompact: false,
    pendingHeapCompact: false,
    lastCompactTurn: null,
    setFailures: null,
  }
  const { aborted, failures: failuresOverride, splitConsumes, compacted, ...depOverrides } = overrides
  const failures = failuresOverride ?? { consecutiveFailures: 0 }
  const msgs = overrides.getMessages ? overrides.getMessages() : bigMsgs(4)

  const deps: CompactBoundaryDeps = {
    getCompactFailures: () => failures,
    setCompactFailures: (f) => { calls.setFailures = f },
    getLastCompactTurn: () => calls.lastCompactTurn,
    setLastCompactTurn: (t) => { calls.lastCompactTurn = t },
    getPendingStaleCompact: () => calls.pendingStaleCompact,
    setPendingStaleCompact: (v) => { calls.pendingStaleCompact = v },
    getPendingHeapCompact: () => calls.pendingHeapCompact,
    setPendingHeapCompact: (v) => { calls.pendingHeapCompact = v },
    getPrevPhaseHint: () => undefined,
    setPrevPhaseHint: () => {},
    getAbortSignal: () => (aborted ? ({ aborted: true } as AbortSignal) : undefined),
    getContextWindow: () => 200_000,
    getPhaseHint: () => undefined,
    getEstimatedTokens: () => 0,
    getMessages: () => msgs,
    replaceMessages: () => { calls.replaceMessages++ },
    dietMessages: (m) => ({ removedCount: 0, messages: m }),
    trySessionSplit: async () => splitConsumes ?? false,
    maybeCompact: async () => {
      calls.maybeCompact++
      return { compacted: compacted ?? false, failures }
    },
    tryPartialCompact: async () => false,
    shouldDelayCompact: () => false,
    getStalePreviewChars: () => 0,
    isCachePreservingProvider: () => false,
    injectImmuneSignal: (s) => { calls.immuneSignals.push(s) },
    ...depOverrides,
  }
  return { coord: new CompactBoundaryCoordinator(deps), calls }
}

describe('CompactBoundaryCoordinator (C-line: extracted, was untested)', () => {
  it('short-circuits with shouldAbort once the signal aborts after a session split', async () => {
    const { coord, calls } = makeCoord({ splitConsumes: true, aborted: true })
    const r = await coord.runCompaction(5, null)
    assert.deepEqual(r, { compacted: false, shouldAbort: true, userMessageConsumed: true })
    assert.equal(calls.maybeCompact, 0, 'aborts before attempting maybeCompact')
  })

  it('emits a compaction_fail immune signal when failures accumulate', async () => {
    const { coord, calls } = makeCoord({ failures: { consecutiveFailures: 2 } })
    await coord.runCompaction(3, null)
    assert.equal(calls.immuneSignals.length, 1)
    assert.equal(calls.immuneSignals[0]!.kind, 'compaction_fail')
    assert.equal(calls.immuneSignals[0]!.source, 'compaction-controller')
    assert.ok(Math.abs(calls.immuneSignals[0]!.severity - 0.6) < 1e-9, 'severity = min(1, 2*0.3)')
  })

  it('emits no immune signal when there are no failures', async () => {
    const { coord, calls } = makeCoord({ failures: { consecutiveFailures: 0 } })
    await coord.runCompaction(3, null)
    assert.equal(calls.immuneSignals.length, 0)
  })

  it('P2-5: defers stale-round compaction off-boundary (turn ≠ 0) — no history rewrite', async () => {
    // tokenRatio well above 0.5 (huge messages, small window) but turn ≠ 0.
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000,
      getMessages: () => bigMsgs(6, 4_000),
    })
    const r = await coord.runCompaction(5, null)
    assert.equal(calls.pendingStaleCompact, true, 'stale compaction is queued, not executed')
    assert.equal(calls.replaceMessages, 0, 'NO message replacement off-boundary (cache-safe)')
    assert.equal(r.shouldAbort, false)
  })

  it('P2-5: defers heap compaction off-boundary on 1M windows — no micro-compact rewrite', async () => {
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000_000,
      getMessages: () => bigMsgs(12),
    })
    const r = await coord.runCompaction(5, {
      memory: { heapUsedBytes: 80, memoryLimitBytes: 100 }, // ratio 0.8 ≥ 0.75 (1M threshold)
    })
    assert.equal(calls.pendingHeapCompact, true, 'heap compaction queued for the next boundary')
    assert.equal(calls.replaceMessages, 0, 'NO micro-compact rewrite off-boundary (cache-safe)')
    assert.equal(r.compacted, false)
  })

  it('emergency valve: forces in-turn heap compaction on 1M windows at ratio ≥ 0.85 (turn ≠ 0)', async () => {
    // Above the emergency band the turn-0 deferral is a death trap: a long/wedged
    // run never returns to turn 0, so deferring risks OOM. The valve must compact
    // in-turn instead of queuing — observable as setPendingHeapCompact(false), the
    // opposite of the deferral path which queues with setPendingHeapCompact(true).
    const setCalls: boolean[] = []
    const { coord } = makeCoord({
      getContextWindow: () => 1_000_000,
      getMessages: () => bigMsgs(12),
      setPendingHeapCompact: (v) => { setCalls.push(v) },
    })
    const r = await coord.runCompaction(5, {
      memory: { heapUsedBytes: 90, memoryLimitBytes: 100 }, // ratio 0.9 ≥ 0.85 emergency
    })
    assert.ok(setCalls.includes(false), 'emergency compacts in-turn (does not queue)')
    assert.ok(!setCalls.includes(true), 'emergency must NOT defer to turn 0')
    assert.equal(r.shouldAbort, false)
  })

  it('records lastCompactTurn and consumes the user message when maybeCompact compacts', async () => {
    const { coord, calls } = makeCoord({ compacted: true })
    const r = await coord.runCompaction(7, null)
    assert.equal(r.compacted, true)
    assert.equal(r.userMessageConsumed, true)
    assert.equal(calls.lastCompactTurn, 7)
  })
})

describe('CompactBoundaryCoordinator opportunistic compact (cold cache)', () => {
  // Track entry into the stale-round compaction body via dietMessages — it is
  // the first thing the body does, and never runs when the branch is gated off.
  function makeOpp(opts: {
    cold: boolean
    ratio: number
    delay?: boolean
  }) {
    let dietCalls = 0
    // window 1000, ascii ≈ chars/4 → 4 messages × (ratio×1000) chars = ratio×1000 tokens
    const charsEach = Math.round((opts.ratio * 1000 * 4) / 4)
    const { coord, calls } = makeCoord({
      getContextWindow: () => 1_000,
      getMessages: () => bigMsgs(4, charsEach),
      shouldOpportunisticCompact: () => opts.cold,
      shouldDelayCompact: () => opts.delay ?? false,
      dietMessages: (m) => { dietCalls++; return { removedCount: 0, messages: m } },
    })
    return { coord, calls, dietCalls: () => dietCalls }
  }

  it('cold cache lowers the trigger floor: ratio 0.4 compacts at turn 0', async () => {
    const t = makeOpp({ cold: true, ratio: 0.4 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 1, 'opportunistic path enters the stale-round body')
  })

  it('warm cache keeps the 0.5 floor: ratio 0.4 does nothing', async () => {
    const t = makeOpp({ cold: false, ratio: 0.4 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0, 'without cold-cache signal the 0.5 floor holds')
  })

  it('cold cache still respects the 0.3 floor: ratio 0.2 does nothing', async () => {
    const t = makeOpp({ cold: true, ratio: 0.2 })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0, 'too little stale history — rewrite would not pay off')
  })

  it('cold cache bypasses shouldDelayCompact (its hit-rate memory predates the idle gap)', async () => {
    const t = makeOpp({ cold: true, ratio: 0.6, delay: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 1, 'stale "cache healthy" verdict must not block a cold-cache compact')
  })

  it('warm cache with delay verdict still delays (existing discipline untouched)', async () => {
    const t = makeOpp({ cold: false, ratio: 0.6, delay: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.dietCalls(), 0)
  })

  it('P2-5 unchanged: cold cache never rewrites off-boundary (turn ≠ 0)', async () => {
    const t = makeOpp({ cold: true, ratio: 0.4 })
    await t.coord.runCompaction(5, null)
    assert.equal(t.dietCalls(), 0, 'opportunistic compaction is turn-0 only')
    assert.equal(t.calls.pendingStaleCompact, false, 'sub-0.5 ratio is not queued either')
  })
})

describe('CompactBoundaryCoordinator T9 (provider cost-aware quality compaction)', () => {
  // Build a coord whose T9 gate is reachable (large window) with a tracked
  // tryPartialCompact, configurable cost/cache classification, and an optional
  // phase transition.
  function makeT9(opts: {
    cachePreserving: boolean
    costInsensitive: boolean
    qRatio: number
    phaseTransition: boolean
    partialOk?: boolean
    thresholds?: { perTokenThreshold: number; subscriptionThreshold: number; subscriptionCeiling: number }
  }) {
    const contextWindow = 1_000_000
    let partialCalls = 0
    const { coord, calls } = makeCoord({
      getContextWindow: () => contextWindow,
      getEstimatedTokens: () => Math.round(opts.qRatio * contextWindow),
      getPrevPhaseHint: () => (opts.phaseTransition ? 'explore' : 'build'),
      getPhaseHint: () => 'build',
      isCachePreservingProvider: () => opts.cachePreserving,
      isCostInsensitiveProvider: () => opts.costInsensitive,
      ...(opts.thresholds ? { getQualityThresholds: () => opts.thresholds! } : {}),
      tryPartialCompact: async () => {
        partialCalls++
        return opts.partialOk ?? true
      },
    })
    return { coord, calls, partialCalls: () => partialCalls }
  }

  it('GLM (cache-preserving + subscription): triggers at turn 0 on phase transition above 0.45', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'GLM gets T9 quality compaction')
  })

  it('GLM: ceiling fallback fires above 0.6 even without a phase transition', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.65, phaseTransition: false })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'subscription ceiling (>0.6) triggers without phase change')
  })

  it('GLM: stays below the 0.45 threshold → no compaction', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.4, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'below lean threshold, nothing fires')
  })

  it('DeepSeek (cache-preserving + per-token): SKIPS to protect the paid prefix cache', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: false, qRatio: 0.9, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'DeepSeek never gets T9 (paid cache protection)')
  })

  it('codex/claude (no cache + subscription): leaner 0.45 threshold applies', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: true, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'subscription leaner threshold triggers at 0.5')
  })

  it('openai (no cache + per-token): keeps the 0.55 threshold — 0.5 does NOT trigger', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: false, qRatio: 0.5, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 0, 'per-token non-cache provider stays at 0.55')
  })

  it('openai: triggers above 0.55 on phase transition', async () => {
    const t = makeT9({ cachePreserving: false, costInsensitive: false, qRatio: 0.6, phaseTransition: true })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1)
  })

  it('timeout guard: NO T9 mid-turn (turn ≠ 0) for any provider, even GLM well over the ceiling', async () => {
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.9, phaseTransition: true })
    await t.coord.runCompaction(5, null)
    assert.equal(t.partialCalls(), 0, 'mid-turn quality compaction is never allowed (cache re-prefill guard)')
  })

  it('config-tunable: GLM with a lowered subscription threshold (0.267) fires earlier', async () => {
    const aggressive = { perTokenThreshold: 0.55, subscriptionThreshold: 0.267, subscriptionCeiling: 0.4 }
    // qRatio 0.3 is below the 0.45 default but above the 0.267 override → triggers.
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.3, phaseTransition: true, thresholds: aggressive })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'lowered config threshold compacts GLM/MiMo earlier')
  })

  it('config-tunable: lowered subscription ceiling fires without a phase transition', async () => {
    const aggressive = { perTokenThreshold: 0.55, subscriptionThreshold: 0.45, subscriptionCeiling: 0.3 }
    const t = makeT9({ cachePreserving: true, costInsensitive: true, qRatio: 0.35, phaseTransition: false, thresholds: aggressive })
    await t.coord.runCompaction(0, null)
    assert.equal(t.partialCalls(), 1, 'ceiling override triggers without phase change')
  })
})
