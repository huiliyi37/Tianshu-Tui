import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import type { AnchorGraphInput } from '../anchor-graph.js'
import { createAnchorGraph } from '../anchor-graph.js'
import { checkInvariants } from '../anchor-invariants.js'

// ─── Test fixtures ───

/**
 * Build a default valid input where INV-1 passes
 * (structure and void are XOR complements).
 */
function makeInput(overrides: Partial<AnchorGraphInput> = {}): AnchorGraphInput {
  return {
    structureHash: '0'.repeat(64),
    voidShape: 'f'.repeat(64),
    prevCycleClose: 'p'.repeat(64),
    currentCycleOpen: 'c'.repeat(64),
    centerBeliefHash: 'b'.repeat(64),
    ...overrides,
  }
}

// ─── Structure tests ───

describe('createAnchorGraph: structure', () => {
  it('creates a graph with exactly 5 nodes', () => {
    const graph = createAnchorGraph(makeInput())
    assert.equal(graph.nodes.length, 5)
  })

  it('each node has id, hash, and role', () => {
    const graph = createAnchorGraph(makeInput())
    const expectedIds = [
      'pole_structure',
      'pole_void',
      'cycle_close',
      'cycle_open',
      'center_belief',
    ] as const

    for (const id of expectedIds) {
      const node = graph.nodes.find(n => n.id === id)
      assert.ok(node, `node ${id} must exist`)
      assert.equal(node.hash.length, 64, `node ${id} must have 64-char sha256 hash`)
      assert.ok(node.role.length > 0, `node ${id} must have non-empty role`)
    }
  })

  it('graph hash is deterministic for same input', () => {
    const input = makeInput()
    const g1 = createAnchorGraph(input)
    const g2 = createAnchorGraph(input)
    assert.equal(g1.graphHash, g2.graphHash)
  })

  it('graph hash changes when any input hash changes', () => {
    const g1 = createAnchorGraph(makeInput())
    const g2 = createAnchorGraph(
      makeInput({ currentCycleOpen: 'a'.repeat(64) }),
    )
    assert.notEqual(g1.graphHash, g2.graphHash)
  })

  it('graph hash is 64 hex characters', () => {
    const graph = createAnchorGraph(makeInput())
    assert.equal(graph.graphHash.length, 64)
    assert.match(graph.graphHash, /^[0-9a-f]{64}$/)
  })

  it('nodes are in canonical order', () => {
    const graph = createAnchorGraph(makeInput())
    const expectedOrder = [
      'pole_structure',
      'pole_void',
      'cycle_close',
      'cycle_open',
      'center_belief',
    ]
    assert.deepEqual(
      graph.nodes.map(n => n.id),
      expectedOrder,
    )
  })
})

// ─── Invariant tests ───

describe('checkInvariants: INV-1 (complementary pair)', () => {
  it('passes when structure and void are XOR complements', () => {
    const graph = createAnchorGraph(
      makeInput({ structureHash: '0'.repeat(64), voidShape: 'f'.repeat(64) }),
    )
    const violations = checkInvariants(graph, {})
    const inv1 = violations.filter(v => v.invariant === 'INV-1')
    assert.equal(inv1.length, 0, 'complementary pair should pass INV-1')
  })

  it('passes with another valid complementary pair', () => {
    // 'a' ^ '5' = 0xf, so 'a'.repeat(64) ^ '5'.repeat(64) = 'f'.repeat(64)
    const graph = createAnchorGraph(
      makeInput({
        structureHash: 'a'.repeat(64),
        voidShape: '5'.repeat(64),
      }),
    )
    const violations = checkInvariants(graph, {})
    const inv1 = violations.filter(v => v.invariant === 'INV-1')
    assert.equal(inv1.length, 0)
  })

  it('violation: non-complementary pair', () => {
    const graph = createAnchorGraph(
      makeInput({
        structureHash: '0'.repeat(64),
        voidShape: '0'.repeat(64), // same as structure, not complement
      }),
    )
    const violations = checkInvariants(graph, {})
    const inv1 = violations.find(v => v.invariant === 'INV-1')
    assert.ok(inv1, 'non-complementary pair must trigger INV-1 violation')
    assert.equal(inv1.severity, 'warning')
  })

  it('violation: different length hashes cannot be complementary', () => {
    const graph = createAnchorGraph(
      makeInput({ structureHash: '0', voidShape: 'f'.repeat(64) }),
    )
    const violations = checkInvariants(graph, {})
    const inv1 = violations.find(v => v.invariant === 'INV-1')
    assert.ok(inv1, 'different length hashes must trigger INV-1 violation')
  })
})

describe('checkInvariants: INV-2 (cycle relay)', () => {
  it('skipped when no prevSessionCycleClose provided', () => {
    const graph = createAnchorGraph(makeInput())
    const violations = checkInvariants(graph, {})
    const inv2 = violations.filter(v => v.invariant === 'INV-2')
    assert.equal(inv2.length, 0, 'INV-2 should be skipped without prev data')
  })

  it('passes when cycle_close matches prev session close', () => {
    const cycleCloseHash = 'ccc'.repeat(21) + 'cc' // 65 chars → trim to 64
    const exact64 = cycleCloseHash.slice(0, 64)
    const graph = createAnchorGraph(
      makeInput({ prevCycleClose: exact64 }),
    )
    const violations = checkInvariants(graph, {
      prevSessionCycleClose: exact64,
    })
    const inv2 = violations.filter(v => v.invariant === 'INV-2')
    assert.equal(inv2.length, 0, 'matching cycle_close should pass INV-2')
  })

  it('violation: cycle_close differs from prev session close', () => {
    const graph = createAnchorGraph(
      makeInput({ prevCycleClose: 'a'.repeat(64) }),
    )
    const violations = checkInvariants(graph, {
      prevSessionCycleClose: 'b'.repeat(64),
    })
    const inv2 = violations.find(v => v.invariant === 'INV-2')
    assert.ok(inv2, 'mismatched cycle_close must trigger INV-2 violation')
    assert.equal(inv2.severity, 'critical')
  })
})

describe('checkInvariants: INV-3 (center_belief non-empty)', () => {
  it('passes when center_belief has a valid hash', () => {
    const graph = createAnchorGraph(
      makeInput({ centerBeliefHash: 'b'.repeat(64) }),
    )
    const violations = checkInvariants(graph, {})
    const inv3 = violations.filter(v => v.invariant === 'INV-3')
    assert.equal(inv3.length, 0)
  })

  it('violation: empty center_belief hash', () => {
    const graph = createAnchorGraph(
      makeInput({ centerBeliefHash: '' }),
    )
    const violations = checkInvariants(graph, {})
    const inv3 = violations.find(v => v.invariant === 'INV-3')
    assert.ok(inv3, 'empty center_belief must trigger INV-3 violation')
    assert.equal(inv3.severity, 'critical')
  })
})

describe('checkInvariants: INV-4 (cycle_open perturbation)', () => {
  it('skipped when no prevCycleOpen provided', () => {
    const graph = createAnchorGraph(makeInput())
    const violations = checkInvariants(graph, {})
    const inv4 = violations.filter(v => v.invariant === 'INV-4')
    assert.equal(inv4.length, 0, 'INV-4 should be skipped without prev data')
  })

  it('passes when cycle_open differs from previous session', () => {
    const graph = createAnchorGraph(
      makeInput({ currentCycleOpen: 'new-session-open-hash'.padEnd(64, 'x') }),
    )
    const violations = checkInvariants(graph, {
      prevCycleOpen: 'old-session-open-hash'.padEnd(64, 'y'),
    })
    const inv4 = violations.filter(v => v.invariant === 'INV-4')
    assert.equal(inv4.length, 0)
  })

  it('violation: cycle_open unchanged across sessions', () => {
    const sameHash = 'z'.repeat(64)
    const graph = createAnchorGraph(
      makeInput({ currentCycleOpen: sameHash }),
    )
    const violations = checkInvariants(graph, { prevCycleOpen: sameHash })
    const inv4 = violations.find(v => v.invariant === 'INV-4')
    assert.ok(inv4, 'unchanged cycle_open must trigger INV-4 violation')
    assert.equal(inv4.severity, 'warning')
  })
})

describe('checkInvariants: INV-5 (graph hash stability)', () => {
  it('skipped when no prevGraphHash provided', () => {
    const graph = createAnchorGraph(makeInput())
    const violations = checkInvariants(graph, { prevGraphHash: null })
    const inv5 = violations.filter(v => v.invariant === 'INV-5')
    assert.equal(inv5.length, 0, 'INV-5 should be skipped on first check')
  })

  it('passes when graph hash is unchanged within session', () => {
    const graph = createAnchorGraph(makeInput())
    const violations = checkInvariants(graph, {
      prevGraphHash: graph.graphHash,
    })
    const inv5 = violations.filter(v => v.invariant === 'INV-5')
    assert.equal(inv5.length, 0)
  })

  it('violation: graph hash changed within session', () => {
    const graph = createAnchorGraph(makeInput())
    const violations = checkInvariants(graph, {
      prevGraphHash: 'different-graph-hash-within-same-session-1234567890',
    })
    const inv5 = violations.find(v => v.invariant === 'INV-5')
    assert.ok(inv5, 'changed graph hash must trigger INV-5 violation')
    assert.equal(inv5.severity, 'critical')
  })
})

describe('checkInvariants: combined scenarios', () => {
  it('returns empty array when all invariants pass', () => {
    const input = makeInput()
    const graph = createAnchorGraph(input)
    const violations = checkInvariants(graph, {
      prevGraphHash: graph.graphHash,
      prevCycleOpen: 'different-open-hash'.padEnd(64, 'q'),
      prevSessionCycleClose: input.prevCycleClose,
    })
    assert.equal(violations.length, 0, 'all invariants should pass')
  })

  it('reports multiple violations together', () => {
    const graph = createAnchorGraph(
      makeInput({
        structureHash: '0'.repeat(64),
        voidShape: '0'.repeat(64), // INV-1 violation
        centerBeliefHash: '', // INV-3 violation
      }),
    )
    const violations = checkInvariants(graph, {
      prevGraphHash: 'different-hash', // INV-5 violation
    })
    const ids = violations.map(v => v.invariant).sort()
    assert.deepEqual(ids, ['INV-1', 'INV-3', 'INV-5'])
  })

  it('all violations have message and severity', () => {
    const graph = createAnchorGraph(
      makeInput({ centerBeliefHash: '' }),
    )
    const violations = checkInvariants(graph, {
      prevGraphHash: 'different',
    })
    for (const v of violations) {
      assert.ok(v.message.length > 0, `${v.invariant} must have message`)
      assert.ok(
        v.severity === 'warning' || v.severity === 'critical',
        `${v.invariant} severity must be warning or critical`,
      )
    }
  })
})

// ─── Fingerprint integration tests ───

describe('anchor-graph: fingerprint integration', () => {
  it('computeAnchorGraphHash returns stable 64-char hex hash', async () => {
    // Dynamic import to verify the fingerprint extension compiles
    const { computeAnchorGraphHash } = await import('../fingerprint.js')
    const graph = createAnchorGraph(makeInput())
    const h1 = computeAnchorGraphHash(graph)
    const h2 = computeAnchorGraphHash(graph)
    assert.equal(h1, h2, 'same graph must produce same hash')
    assert.equal(h1.length, 64, 'must be sha256 hex')
    assert.match(h1, /^[0-9a-f]{64}$/)
  })

  it('computeAnchorGraphHash differs from graph.graphHash', async () => {
    const { computeAnchorGraphHash } = await import('../fingerprint.js')
    const graph = createAnchorGraph(makeInput())
    const h = computeAnchorGraphHash(graph)
    assert.notEqual(
      h,
      graph.graphHash,
      'computeAnchorGraphHash uses a different salt, must not collide with graph.graphHash',
    )
  })
})
