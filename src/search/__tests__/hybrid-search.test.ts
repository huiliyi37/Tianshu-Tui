import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { reciprocalRankFusion } from '../hybrid-search.js'
import { cosineSimilarity, VectorIndex } from '../vector-index.js'

describe('hybrid-search: reciprocalRankFusion', () => {
  it('rewards items ranked highly across multiple lists', () => {
    const bm25 = [{ id: 'a' }, { id: 'b' }, { id: 'c' }]
    const vector = [{ id: 'c' }, { id: 'a' }, { id: 'd' }]
    const fused = reciprocalRankFusion([bm25, vector])
    // 'a' (ranks 1 & 2) and 'c' (ranks 3 & 1) appear in both → outrank single-list items.
    const top2 = fused.slice(0, 2).map(f => f.id).sort()
    assert.deepEqual(top2, ['a', 'c'])
  })

  it('includes items present in only one list', () => {
    const fused = reciprocalRankFusion([[{ id: 'x' }], [{ id: 'y' }]])
    const ids = fused.map(f => f.id).sort()
    assert.deepEqual(ids, ['x', 'y'])
  })

  it('returns empty for empty input', () => {
    assert.deepEqual(reciprocalRankFusion([]), [])
  })
})

describe('hybrid-search: cosineSimilarity', () => {
  it('is 1 for identical direction', () => {
    assert.ok(Math.abs(cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9)
  })
  it('is 0 for orthogonal vectors', () => {
    assert.equal(cosineSimilarity([1, 0], [0, 1]), 0)
  })
  it('guards against degenerate input', () => {
    assert.equal(cosineSimilarity([], []), 0)
    assert.equal(cosineSimilarity([0, 0], [1, 1]), 0)
    assert.equal(cosineSimilarity([1, 2], [1]), 0)
  })
})

describe('vector-index', () => {
  it('returns nearest neighbours by cosine', () => {
    const vi = new VectorIndex()
    vi.add('a:1-1', [1, 0])
    vi.add('b:1-1', [0.9, 0.1])
    vi.add('c:1-1', [0, 1])
    const hits = vi.search([1, 0], 2)
    assert.equal(hits[0]!.id, 'a:1-1')
    assert.equal(hits[1]!.id, 'b:1-1')
  })

  it('removeFile drops all chunks of a file', () => {
    const vi = new VectorIndex()
    vi.add('src/x.ts:1-10', [1, 0])
    vi.add('src/x.ts:11-20', [0, 1])
    vi.add('src/y.ts:1-5', [1, 1])
    vi.removeFile('src/x.ts')
    assert.equal(vi.size, 1)
    assert.ok(vi.has('src/y.ts:1-5'))
  })

  it('snapshot round-trips only for the matching provider', () => {
    const vi = new VectorIndex()
    vi.providerId = 'remote:m1'
    vi.add('a:1-1', [1, 2, 3])
    const snap = vi.toSnapshot()

    const vi2 = new VectorIndex()
    assert.equal(vi2.loadSnapshot(snap, 'remote:m2'), false, 'mismatched provider rejected')
    assert.equal(vi2.loadSnapshot(snap, 'remote:m1'), true, 'matching provider accepted')
    assert.equal(vi2.size, 1)
  })
})
