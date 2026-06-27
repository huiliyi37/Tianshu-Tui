import { test } from 'node:test'
import assert from 'node:assert/strict'
import type { DelegationNode } from '../../runtime/types'

// Import the pure tree-building logic for unit testing.
// DelegationSurface delegates rendering to React but the tree structure
// (parent→children map, orphan-root detection, depth assignment) is pure
// and tested here independently.
import { buildDelegationForest, type TreeNode } from '../../surfaces/DelegationSurface.tsx'

function node(workerId: string, parentId: string | undefined, extra: Partial<DelegationNode> = {}): DelegationNode {
  return { workerId, parentId, objective: extra.objective ?? '', status: extra.status ?? 'running', updatedAt: 0, ...extra }
}

// ── buildDelegationForest: tree construction contract ──────────

test('buildDelegationForest: empty nodes → empty forest', () => {
  const forest = buildDelegationForest({})
  assert.equal(forest.length, 0)
})

test('buildDelegationForest: single root (no parentId)', () => {
  const nodes = { w1: node('w1', undefined) }
  const forest = buildDelegationForest(nodes)
  assert.equal(forest.length, 1)
  assert.equal(forest[0]!.node.workerId, 'w1')
  assert.equal(forest[0]!.children.length, 0)
  assert.equal(forest[0]!.depth, 0)
})

test('buildDelegationForest: parent → child linked correctly', () => {
  const nodes = {
    tool1: node('tool1', undefined),
    w1: node('w1', 'tool1'),
    w2: node('w2', 'tool1'),
  }
  const forest = buildDelegationForest(nodes)
  assert.equal(forest.length, 1, 'one root')
  assert.equal(forest[0]!.node.workerId, 'tool1')
  assert.equal(forest[0]!.children.length, 2, 'two children')
  assert.deepEqual(forest[0]!.children.map(c => c.node.workerId).sort(), ['w1', 'w2'])
  // Children are at depth 1.
  assert.equal(forest[0]!.children[0]!.depth, 1)
})

test('buildDelegationForest: three-level chain (grandparent → parent → child)', () => {
  const nodes = {
    root: node('root', undefined),
    mid: node('mid', 'root'),
    leaf: node('leaf', 'mid'),
  }
  const forest = buildDelegationForest(nodes)
  assert.equal(forest.length, 1)
  assert.equal(forest[0]!.children[0]!.node.workerId, 'mid')
  assert.equal(forest[0]!.children[0]!.children[0]!.node.workerId, 'leaf')
  assert.equal(forest[0]!.children[0]!.children[0]!.depth, 2)
})

test('buildDelegationForest: missing parent → orphan becomes root', () => {
  // w1 references parent 'ghost' which doesn't exist → w1 is an orphan root.
  const nodes = { w1: node('w1', 'ghost') }
  const forest = buildDelegationForest(nodes)
  assert.equal(forest.length, 1, 'orphan promoted to root')
  assert.equal(forest[0]!.node.workerId, 'w1')
  assert.equal(forest[0]!.depth, 0)
})

test('buildDelegationForest: multiple independent roots', () => {
  const nodes = {
    t1: node('t1', undefined),
    t2: node('t2', undefined),
  }
  const forest = buildDelegationForest(nodes)
  assert.equal(forest.length, 2)
})

test('buildDelegationForest: circular reference does not infinite-loop', () => {
  // a → b → a (cycle). Must terminate, treating the cycle entry as a root.
  const nodes = {
    a: node('a', 'b'),
    b: node('b', 'a'),
  }
  const forest = buildDelegationForest(nodes)
  // Must not hang or crash. Forest should contain reachable nodes.
  const all = new Set<string>()
  function collect(ts: TreeNode[]) {
    for (const t of ts) { all.add(t.node.workerId); collect(t.children) }
  }
  collect(forest)
  assert.ok(all.has('a') || all.has('b'), 'at least one node present')
})

test('buildDelegationForest: TreeNode preserves DelegationNode fields', () => {
  const rich: DelegationNode = {
    workerId: 'w1', parentId: undefined, objective: 'scan code',
    status: 'running', profile: 'code_scout', model: 'gpt-5', provider: 'openai',
    elapsedMs: 1200, progressLine: '⚙ grep', updatedAt: 999,
  }
  const forest = buildDelegationForest({ w1: rich })
  assert.equal(forest[0]!.node.model, 'gpt-5')
  assert.equal(forest[0]!.node.profile, 'code_scout')
  assert.equal(forest[0]!.node.elapsedMs, 1200)
})

test('buildDelegationForest: tree nodes ordered by updatedAt within siblings', () => {
  const nodes = {
    root: node('root', undefined),
    b: node('b', 'root', { updatedAt: 200 }),
    a: node('a', 'root', { updatedAt: 100 }),
    c: node('c', 'root', { updatedAt: 300 }),
  }
  const forest = buildDelegationForest(nodes)
  const order = forest[0]!.children.map(c => c.node.workerId)
  assert.deepEqual(order, ['a', 'b', 'c'], 'siblings sorted by updatedAt ascending')
})
