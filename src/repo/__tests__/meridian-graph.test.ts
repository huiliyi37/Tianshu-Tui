import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { spreadingActivation, buildRepoMap } from '../meridian-graph.js'
import { MeridianDb } from '../meridian-db.js'
import { queryFlow, reviveDeletedFile, isUnnamedSymbolId } from '../meridian-indexer.js'
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
      calls: [],
    })
    db.upsertFile({
      filePath: 'src/b.ts', contentHash: 'h2',
      symbols: [
        { id: 'src/b.ts:baz:1', name: 'baz', kind: 'function', filePath: 'src/b.ts', line: 1, exported: true, contentHash: 'h2' },
      ],
      edges: [{ sourceId: 'src/b.ts:baz:1', targetId: 'src/c.ts:qux:1', kind: 'calls', weight: 1.0 }],
      imports: ['./c.js'],
      calls: [],
    })
    db.upsertFile({
      filePath: 'src/c.ts', contentHash: 'h3',
      symbols: [
        { id: 'src/c.ts:qux:1', name: 'qux', kind: 'function', filePath: 'src/c.ts', line: 1, exported: true, contentHash: 'h3' },
      ],
      edges: [],
      imports: [],
      calls: [],
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

  it('flow 两端 named 约束：未命名 seed 拒绝、命中点均为命名符号', () => {
    assert.deepEqual(queryFlow(db, 'src/a.ts:*:0'), [])
    const hits = queryFlow(db, 'src/a.ts:foo:1')
    assert.ok(hits.length > 0)
    for (const h of hits) assert.ok(!isUnnamedSymbolId(h.symbolId))
  })

  it('flow 允许 ≤1 个未命名桥穿过（CodeGraph MAX_BRIDGE=1）', () => {
    // bar 无既有边（fixture 里 foo→baz→qux 是 0 桥路径），只能经桥命中
    db.upsertEdge('src/a.ts:foo:1', 'src/bridge.ts:*:0', 'calls', 1.0)
    db.upsertEdge('src/bridge.ts:*:0', 'src/a.ts:bar:5', 'calls', 1.0)
    const hits = queryFlow(db, 'src/a.ts:foo:1')
    const bar = hits.find(h => h.symbolId === 'src/a.ts:bar:5')
    assert.ok(bar, '经 1 个未命名桥应命中 bar')
    assert.equal(bar.bridges, 1)
  })

  it('flow 剪掉 ≥2 个未命名桥的路径', () => {
    db.upsertEdge('src/a.ts:foo:1', 'src/u1.ts:*:0', 'calls', 1.0)
    db.upsertEdge('src/u1.ts:*:0', 'src/u2.ts:*:0', 'calls', 1.0)
    db.upsertEdge('src/u2.ts:*:0', 'src/a.ts:bar:5', 'calls', 1.0)
    const hits = queryFlow(db, 'src/a.ts:foo:1')
    assert.ok(!hits.some(h => h.symbolId === 'src/a.ts:bar:5'), '2 桥路径应被剪掉')
  })

  it('flow maxBridges=0 时不穿过未命名节点', () => {
    db.upsertEdge('src/a.ts:foo:1', 'src/bridge.ts:*:0', 'calls', 1.0)
    db.upsertEdge('src/bridge.ts:*:0', 'src/a.ts:bar:5', 'calls', 1.0)
    const hits = queryFlow(db, 'src/a.ts:foo:1', { maxBridges: 0 })
    assert.ok(!hits.some(h => h.symbolId === 'src/a.ts:bar:5'), 'maxBridges=0 时 bar 只经桥可达，应被排除')
  })

  it('删除文件时跨文件入边复活为 pending 而非静默断裂', () => {
    const revived = reviveDeletedFile(db, 'src/b.ts')
    assert.equal(revived, 1, 'foo→baz 是唯一跨文件入边')
    // 依赖方仍能查到（target 指向文件级占位，GLOB `src/b.ts:*` 仍命中）
    const deps = db.getReverseDependents('src/b.ts')
    assert.ok(deps.some(d => d.file === 'src/a.ts'), '依赖关系不应静默断裂')
    // 符号清空，pending 边存在
    assert.equal(db.getSymbolsForFile('src/b.ts').length, 0)
    const pending = db.getEdgesTo('src/b.ts:*:0')
    assert.ok(pending.some(e => e.sourceId === 'src/a.ts:foo:1'), '入边应复活为指向文件级占位')
  })
})
