import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spreadingActivation, buildRepoMap } from '../meridian-graph.js'
import { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian graph', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-graph-'))
    db = new MeridianDb(dir)
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:foo:1', name: 'foo', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
        { id: 'src/a.ts:bar:5', name: 'bar', kind: 'function', filePath: 'src/a.ts', line: 5, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'src/a.ts:foo:1', targetId: 'src/b.ts:baz:1', kind: 'calls', weight: 1.0 }],
      imports: ['./b.js'],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [
        { id: 'src/b.ts:baz:1', name: 'baz', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' },
      ],
      edges: [{ sourceId: 'src/b.ts:baz:1', targetId: 'src/c.ts:qux:1', kind: 'calls', weight: 1.0 }],
      imports: ['./c.js'],
    })
    db.upsertFile({
      filePath: 'src/c.ts', contentHash: 'h3',
      symbols: [
        { id: 'src/c.ts:qux:1', name: 'qux', kind: 'function', filePath: 'src/c.ts', line: 1, exported: true, contentHash: 'h3' },
      ],
      edges: [],
      imports: [],
    })
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('spreading activation returns scores decaying with distance', () => {
    const scores = spreadingActivation(db, 'src/a.ts', { maxHops: 3, decay: 0.5 })
    const scoreA = scores.get('src/a.ts')!
    const scoreB = scores.get('src/b.ts')!
    const scoreC = scores.get('src/c.ts')!
    assert.ok(scoreA > scoreB, `a(${scoreA}) should > b(${scoreB})`)
    assert.ok(scoreB > scoreC, `b(${scoreB}) should > c(${scoreC})`)
  })

  it('seed file has score 1.0', () => {
    const scores = spreadingActivation(db, 'src/a.ts', { maxHops: 2, decay: 0.5 })
    assert.equal(scores.get('src/a.ts'), 1.0)
  })

  it('buildRepoMap returns entries sorted by score', () => {
    const result = buildRepoMap(db, 'src/a.ts', { maxHops: 3, decay: 0.5, maxTokens: 2000 })
    assert.ok(result.entries.length >= 2)
    assert.equal(result.entries[0]!.filePath, 'src/a.ts')
    for (let i = 1; i < result.entries.length; i++) {
      assert.ok(result.entries[i - 1]!.score >= result.entries[i]!.score)
    }
  })

  it('buildRepoMap respects token budget', () => {
    // With very small budget, should limit entries
    const result = buildRepoMap(db, 'src/a.ts', { maxHops: 3, decay: 0.5, maxTokens: 50 })
    // At least seed file is always included
    assert.ok(result.entries.length >= 1)
    assert.ok(result.entries.length <= 3)
  })

  it('reports graph stats', () => {
    const result = buildRepoMap(db, 'src/a.ts', { maxHops: 2, decay: 0.5, maxTokens: 2000 })
    assert.equal(result.graphSize, 3)
    assert.equal(result.totalSymbols, 4)
  })
})
