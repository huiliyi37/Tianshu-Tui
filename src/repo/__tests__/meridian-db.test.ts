import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('meridian db', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-'))
    db = new MeridianDb(dir)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('upserts and retrieves symbols', () => {
    db.upsertFile({
      filePath: 'src/foo.ts',
      contentHash: 'abc123',
      symbols: [{ id: 'src/foo.ts:hello:1', name: 'hello', kind: 'function', filePath: 'src/foo.ts', line: 1, exported: true, contentHash: 'abc123' }],
      edges: [],
      imports: ['./bar.js'],
    })
    const symbols = db.getSymbolsForFile('src/foo.ts')
    assert.equal(symbols.length, 1)
    assert.equal(symbols[0]!.name, 'hello')
  })

  it('skips re-parse when hash matches', () => {
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), true)
    db.upsertFile({ filePath: 'src/foo.ts', contentHash: 'hash1', symbols: [], edges: [], imports: [] })
    assert.equal(db.needsParse('src/foo.ts', 'hash1'), false)
    assert.equal(db.needsParse('src/foo.ts', 'hash2'), true)
  })

  it('stores and retrieves edges', () => {
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'h1',
      symbols: [
        { id: 'src/a.ts:A:1', name: 'A', kind: 'class', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' },
      ],
      edges: [{ sourceId: 'src/a.ts:A:1', targetId: 'src/b.ts:B:1', kind: 'imports', weight: 1.0 }],
      imports: ['./b.js'],
    })
    const edges = db.getEdgesFrom('src/a.ts:A:1')
    assert.equal(edges.length, 2) // explicit edge + import edge from first symbol
    assert.ok(edges.some(e => e.targetId === 'src/b.ts:B:1'))
  })

  it('records access and returns access count', () => {
    db.recordAccess('src/foo.ts')
    db.recordAccess('src/foo.ts')
    const count = db.getAccessCount('src/foo.ts')
    assert.equal(count, 2)
  })

  it('returns neighbors within N hops', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [{ id: 'a:X:1', name: 'X', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [{ sourceId: 'a:X:1', targetId: 'b:Y:1', kind: 'calls', weight: 1.0 }],
      imports: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [{ id: 'b:Y:1', name: 'Y', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' }],
      edges: [{ sourceId: 'b:Y:1', targetId: 'c:Z:1', kind: 'calls', weight: 1.0 }],
      imports: [],
    })
    const neighbors = db.getNeighborIds('a:X:1', 2)
    assert.ok(neighbors.has('b:Y:1'))
    assert.ok(neighbors.has('c:Z:1'))
  })

  it('returns stats', () => {
    db.upsertFile({
      filePath: 'src/a.ts', contentHash: 'h1',
      symbols: [{ id: 'a:X:1', name: 'X', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [{ sourceId: 'a:X:1', targetId: 'b:Y:1', kind: 'calls', weight: 1.0 }],
      imports: [],
    })
    const stats = db.getStats()
    assert.equal(stats.files, 1)
    assert.equal(stats.symbols, 1)
    assert.equal(stats.edges, 1)
  })

  it('saves and loads physarum edges', () => {
    db.savePhysarumEdges([
      { fileA: 'a.ts', fileB: 'b.ts', weight: 2.5, flow: 3, consolidated: true, activationCount: 7, lastActivatedTurn: 12, direction: 0.4 },
      { fileA: 'c.ts', fileB: 'd.ts', weight: 1.0, flow: 0, consolidated: false, activationCount: 1, lastActivatedTurn: 1, direction: 0 },
    ])
    const loaded = db.loadPhysarumEdges()
    assert.equal(loaded.length, 2)
    const first = loaded.find(e => e.fileA === 'a.ts')!
    assert.equal(first.weight, 2.5)
    assert.equal(first.consolidated, true)
    assert.equal(first.activationCount, 7)
    assert.equal(first.direction, 0.4)
  })

  it('records and retrieves physarum prediction observations newest first', () => {
    db.recordPhysarumPredictionObservation({
      sourceFile: 'src/a.ts',
      predictedAtTurn: 1,
      predictions: [{ file: 'src/b.ts', score: 2.5 }],
      observedFile: 'src/b.ts',
      observedAtTurn: 2,
      hitRank: 1,
      leadTurns: 1,
    })
    db.recordPhysarumPredictionObservation({
      sourceFile: 'src/b.ts',
      predictedAtTurn: 2,
      predictions: [{ file: 'src/a.ts', score: 1.2 }],
      observedFile: 'src/c.ts',
      observedAtTurn: 3,
      hitRank: null,
      leadTurns: 1,
    })

    const loaded = db.getPhysarumPredictionObservations(10)
    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.sourceFile, 'src/b.ts')
    assert.equal(loaded[0]!.hitRank, null)
    assert.deepEqual(loaded[1]!.predictions, [{ file: 'src/b.ts', score: 2.5 }])
  })

  it('does not create meridian.db on construction (lazy open)', () => {
    const lazyDir = mkdtempSync(join(tmpdir(), 'meridian-lazy-'))
    try {
      const lazyDb = new MeridianDb(lazyDir)
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), false, 'db file should NOT exist after construction')
      // First actual query triggers lazy open
      assert.deepEqual(lazyDb.getSymbolsForFile('src/none.ts'), [])
      assert.equal(existsSync(join(lazyDir, 'meridian.db')), true, 'db file SHOULD exist after first query')
      lazyDb.close()
    } finally {
      rmSync(lazyDir, { recursive: true, force: true })
    }
  })

  it('savePhysarumEdges replaces previous state', () => {
    db.savePhysarumEdges([
      { fileA: 'x.ts', fileB: 'y.ts', weight: 1.0, flow: 1, consolidated: false, activationCount: 1, lastActivatedTurn: 1, direction: 0 },
    ])
    db.savePhysarumEdges([
      { fileA: 'p.ts', fileB: 'q.ts', weight: 3.0, flow: 5, consolidated: true, activationCount: 10, lastActivatedTurn: 20, direction: -0.2 },
    ])
    const loaded = db.loadPhysarumEdges()
    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.fileA, 'p.ts')
  })

  it('saves and loads P3 tool pattern miner state', () => {
    const snapshot = {
      version: 1 as const,
      bigrams: [{
        fromTool: 'grep',
        entries: [{ tool: 'read_file', targetPath: 'src/foo.ts' }],
      }],
      trigrams: [{
        context: 'glob|grep',
        entries: [{ tool: 'read_file', targetPath: 'src/foo.ts' }],
      }],
      prev: 'grep',
    }

    db.saveToolPatternMinerSnapshot(snapshot)

    assert.deepEqual(db.loadToolPatternMinerSnapshot(), snapshot)
  })
})
