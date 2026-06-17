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
  const failures = overrides.failures ?? { consecutiveFailures: 0 }
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
    getAbortSignal: () => (overrides.aborted ? ({ aborted: true } as AbortSignal) : undefined),
    getContextWindow: () => 200_000,
    getPhaseHint: () => undefined,
    getEstimatedTokens: () => 0,
    getMessages: () => msgs,
    replaceMessages: () => { calls.replaceMessages++ },
    dietMessages: (m) => ({ removedCount: 0, messages: m }),
    trySessionSplit: async () => overrides.splitConsumes ?? false,
    maybeCompact: async () => {
      calls.maybeCompact++
      return { compacted: overrides.compacted ?? false, failures }
    },
    tryPartialCompact: async () => false,
    shouldDelayCompact: () => false,
    getStalePreviewChars: () => 0,
    injectImmuneSignal: (s) => { calls.immuneSignals.push(s) },
    ...overrides,
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

  it('records lastCompactTurn and consumes the user message when maybeCompact compacts', async () => {
    const { coord, calls } = makeCoord({ compacted: true })
    const r = await coord.runCompaction(7, null)
    assert.equal(r.compacted, true)
    assert.equal(r.userMessageConsumed, true)
    assert.equal(calls.lastCompactTurn, 7)
  })
})
