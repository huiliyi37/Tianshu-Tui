import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createRuntimeHookContext } from '../runtime-hooks.js'
import { createHearthObserveHook } from '../hooks/hearth-observe-hook.js'
import type { AnchorGraph } from '../../prompt/anchor-graph.js'
import { createAnchorGraph } from '../../prompt/anchor-graph.js'
import type { AnchorViolation } from '../../prompt/anchor-invariants.js'

function makeContext(turn = 7) {
  return createRuntimeHookContext({
    cwd: '/tmp/project',
    turn,
    recentToolHistory: [],
    sensorium: null,
    strategy: null,
    vigor: null,
    gitChangeRate: 0,
    season: null,
  })
}

/**
 * Build a valid anchor graph where INV-1 passes (structure/void complementary).
 */
function makeValidGraph(overrides?: Partial<Parameters<typeof createAnchorGraph>[0]>): AnchorGraph {
  return createAnchorGraph({
    structureHash: '0'.repeat(64),
    voidShape: 'f'.repeat(64),
    prevCycleClose: 'a'.repeat(64),
    currentCycleOpen: 'b'.repeat(64),
    centerBeliefHash: 'c'.repeat(64),
    ...overrides,
  })
}

describe('hearth-observe hook', () => {
  it('does not run when disabled', () => {
    const violations: AnchorViolation[] = []
    const prevHashes: string[] = []

    const hook = createHearthObserveHook({
      enabled: false,
      getAnchorGraph: () => makeValidGraph(),
      getPrevGraphHash: () => null,
      setPrevGraphHash: (h) => { prevHashes.push(h) },
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    assert.equal(violations.length, 0)
    assert.equal(prevHashes.length, 0, 'should not update prev hash when disabled')
  })

  it('reports no violations when all invariants hold', () => {
    const violations: AnchorViolation[] = []
    const prevHashes: string[] = []
    const graph = makeValidGraph()

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => graph.graphHash,  // same → INV-5 passes
      setPrevGraphHash: (h) => { prevHashes.push(h) },
      getPrevCycleOpen: () => 'different-open-hash'.padEnd(64, 'x'),
      getPrevSessionCycleClose: () => graph.nodes.find(n => n.id === 'cycle_close')!.hash,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    assert.equal(violations.length, 0)
    assert.equal(prevHashes.length, 1)
    assert.equal(prevHashes[0], graph.graphHash)
  })

  it('detects INV-1 violation when structure and void are not complementary', () => {
    const violations: AnchorViolation[] = []
    const graph = makeValidGraph({
      structureHash: '0'.repeat(64),
      voidShape: '0'.repeat(64),  // same as structure, not complement
    })

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => null,
      setPrevGraphHash: () => {},
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    const inv1 = violations.filter(v => v.invariant === 'INV-1')
    assert.equal(inv1.length, 1)
    assert.equal(inv1[0]!.severity, 'warning')
  })

  it('detects INV-3 violation when center_belief is empty', () => {
    const violations: AnchorViolation[] = []
    const graph = makeValidGraph({ centerBeliefHash: '' })

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => null,
      setPrevGraphHash: () => {},
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    const inv3 = violations.find(v => v.invariant === 'INV-3')
    assert.ok(inv3, 'empty center_belief should trigger INV-3')
    assert.equal(inv3.severity, 'critical')
  })

  it('detects INV-4 violation when cycle_open unchanged across sessions', () => {
    const violations: AnchorViolation[] = []
    const sameHash = 'z'.repeat(64)
    const graph = makeValidGraph({ currentCycleOpen: sameHash })

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => null,
      setPrevGraphHash: () => {},
      getPrevCycleOpen: () => sameHash,  // same as current → violation
      getPrevSessionCycleClose: () => null,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    const inv4 = violations.find(v => v.invariant === 'INV-4')
    assert.ok(inv4, 'unchanged cycle_open should trigger INV-4')
  })

  it('detects INV-5 violation when graph hash drifts intra-session', () => {
    const violations: AnchorViolation[] = []
    const graph = makeValidGraph()

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => 'different-prev-graph-hash-for-same-session',
      setPrevGraphHash: () => {},
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
      onViolations: (v) => { violations.push(...v) },
    })

    hook.run(makeContext())

    const inv5 = violations.find(v => v.invariant === 'INV-5')
    assert.ok(inv5, 'graph hash drift should trigger INV-5')
    assert.equal(inv5.severity, 'critical')
  })

  it('updates prev graph hash after each run for next turn INV-5', () => {
    const prevHashes: string[] = []
    const graph = makeValidGraph()

    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => null,
      setPrevGraphHash: (h) => { prevHashes.push(h) },
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
    })

    hook.run(makeContext(1))
    hook.run(makeContext(2))
    hook.run(makeContext(3))

    assert.equal(prevHashes.length, 3)
    assert.equal(prevHashes[0], graph.graphHash)
    assert.equal(prevHashes[1], graph.graphHash)
    assert.equal(prevHashes[2], graph.graphHash)
  })

  it('passes turn number to violation callback', () => {
    const capturedTurns: number[] = []

    const graph = makeValidGraph({ centerBeliefHash: '' })
    const hook = createHearthObserveHook({
      enabled: true,
      getAnchorGraph: () => graph,
      getPrevGraphHash: () => null,
      setPrevGraphHash: () => {},
      getPrevCycleOpen: () => null,
      getPrevSessionCycleClose: () => null,
      onViolations: (_violations, turn) => { capturedTurns.push(turn) },
    })

    hook.run(makeContext(42))

    assert.equal(capturedTurns.length, 1)
    assert.equal(capturedTurns[0], 42)
  })
})
