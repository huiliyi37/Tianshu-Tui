import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
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

  // ─── D6 task 1: LIKE → GLOB precision fixes ─────────────────────────
  it('getTestsFor does not match files whose name differs only by underscore wildcard (tool_x.ts vs toolAx.ts)', () => {
    db.upsertEdge('src/agent/toolA.test.ts:test1:1', 'src/agent/toolAx.ts:foo:1', 'tested_by', 1.0)
    db.upsertEdge('src/agent/toolX.test.ts:test2:1', 'src/agent/tool_x.ts:foo:1', 'tested_by', 1.0)
    assert.deepEqual(db.getTestsFor('src/agent/tool_x.ts'), ['src/agent/toolX.test.ts'])
  })

  it('getReverseDependents does not return callers of a similarly-named file (tool_x.ts vs toolAx.ts)', () => {
    db.upsertEdge('src/agent/caller.ts:call:1', 'src/agent/toolAx.ts:foo:1', 'imports', 1.0)
    db.upsertEdge('src/agent/realCaller.ts:call:1', 'src/agent/tool_x.ts:foo:1', 'imports', 1.0)
    const deps = db.getReverseDependents('src/agent/tool_x.ts')
    assert.deepEqual(deps.map(d => d.file), ['src/agent/realCaller.ts'])
  })

  it('matches file paths case-sensitively (Foo.ts vs foo.ts)', () => {
    db.upsertEdge('src/tests/upper.test.ts:t1:1', 'src/foo.ts:bar:1', 'tested_by', 1.0)
    db.upsertEdge('src/tests/lower.test.ts:t2:1', 'src/Foo.ts:bar:1', 'tested_by', 1.0)
    assert.deepEqual(db.getTestsFor('src/Foo.ts'), ['src/tests/lower.test.ts'])
  })

  // ─── D6 task 2: schema version + legacy migration ──────────────────
  it('reports schema version 1 after open', () => {
    assert.equal(db.schemaVersion(), 1)
  })

  /** Roll user_version back to 0 so the next open sees a pre-v1 database. */
  const markLegacy = () => {
    const Database = resolveBetterSqlite3(import.meta.url)
    const conn = new Database(join(dir, 'meridian.db'))
    try { conn.pragma('user_version = 0') } finally { conn.close() }
  }

  it('migrates legacy absolute-path rows and dangling imports edges on reopen', () => {
    // Historical dirty rows: absolute-path file + its symbol + a dangling imports edge
    db.upsertFile({
      filePath: '/abs/dir/legacy.ts',
      contentHash: 'h1',
      symbols: [{ id: '/abs/dir/legacy.ts:X:1', name: 'X', kind: 'function', filePath: '/abs/dir/legacy.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
    })
    db.upsertEdge('/abs/dir/legacy.ts:X:1', 'src/nonexistent.ts:*:0', 'imports', 1.0)
    // Clean rows that must survive migration
    db.upsertFile({
      filePath: 'src/ok.ts',
      contentHash: 'h2',
      symbols: [{ id: 'src/ok.ts:Y:1', name: 'Y', kind: 'function', filePath: 'src/ok.ts', line: 1, exported: true, contentHash: 'h2' }],
      edges: [],
      imports: [],
    })
    db.upsertEdge('src/ok.ts:Y:1', 'src/ok.ts:*:0', 'imports', 1.0)

    // Reopen a pre-v1 database to trigger the one-shot migration
    db.close()
    markLegacy()
    db = new MeridianDb(dir)

    const files = db.getAllFiles()
    assert.ok(!files.some(f => f.startsWith('/')), `absolute-path rows remain: ${JSON.stringify(files)}`)
    assert.ok(files.includes('src/ok.ts'), 'clean relative row must survive migration')
    assert.equal(db.schemaVersion(), 1)
    // Dangling imports edge purged; valid imports edge kept
    assert.equal(db.getEdgesTo('src/nonexistent.ts:*:0').length, 0, 'dangling imports edge must be purged')
    assert.equal(db.getEdgesTo('src/ok.ts:*:0').length, 1, 'valid imports edge must survive')
  })

  it('migration is idempotent across reopenings', () => {
    db.upsertFile({
      filePath: '/abs/x.ts',
      contentHash: 'h1',
      symbols: [{ id: '/abs/x.ts:Z:1', name: 'Z', kind: 'function', filePath: '/abs/x.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
    })
    db.close()
    markLegacy()
    db = new MeridianDb(dir)
    assert.ok(!db.getAllFiles().some(f => f.startsWith('/')), 'first migration must purge absolute paths')
    db.close()
    db = new MeridianDb(dir)
    assert.ok(!db.getAllFiles().some(f => f.startsWith('/')), 'second migration must be a no-op')
    assert.equal(db.schemaVersion(), 1)
  })

  it('leaves edges to not-yet-indexed files alone once the db is at v1', () => {
    // src/b.ts exists on disk but has not been indexed yet, so the edge into it
    // looks "dangling" to the v1 purge. Re-running the purge on every open would
    // delete it, and the unchanged content hash means it would never come back.
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'ha',
      symbols: [{ id: 'src/a.ts:A:1', name: 'A', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'ha' }],
      edges: [],
      imports: ['src/b.ts'],
    })
    assert.deepEqual(db.getReverseDependents('src/b.ts').map(d => d.file), ['src/a.ts'])

    db.close()
    db = new MeridianDb(dir)
    assert.deepEqual(db.getReverseDependents('src/b.ts').map(d => d.file), ['src/a.ts'],
      'reopen must not purge the reverse-dependency edge of an unindexed target')
    assert.equal(db.needsParse('src/a.ts', 'ha'), false, 'source stays unchanged, so a purged edge could never be rebuilt')
  })
})
