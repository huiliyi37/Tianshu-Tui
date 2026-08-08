import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { rankSearchCandidates, searchPathSalience } from '../search-salience.js'

describe('search salience', () => {
  it('penalizes implementation-adjacent noise while preserving explicit test queries', () => {
    assert.ok(searchPathSalience('src/agent/loop.ts', 'runtime routing') > 1)
    assert.ok(searchPathSalience('src/agent/__tests__/loop.test.ts', 'runtime routing') < 1)
    assert.ok(searchPathSalience('src/agent/__tests__/loop.test.ts', 'test coverage') >= 1)
    assert.equal(searchPathSalience('dist/chunk.js', 'runtime routing'), 0)
  })

  it('keeps diverse files instead of returning overlapping chunks from one file', () => {
    const hits = [
      { file: 'src/agent/loop.ts', score: 10, id: 'loop-1' },
      { file: 'src/agent/loop.ts', score: 9, id: 'loop-2' },
      { file: 'src/agent/loop.ts', score: 8, id: 'loop-3' },
      { file: 'src/tools/galaxy.ts', score: 7, id: 'galaxy-1' },
      { file: 'src/tools/galaxy.test.ts', score: 9, id: 'test-1' },
    ]

    const result = rankSearchCandidates(hits, 'runtime routing', 4)
    assert.deepEqual(result.map(hit => hit.id), ['loop-1', 'galaxy-1', 'loop-2', 'test-1'])
  })
})
