import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianBehavior } from '../meridian-behavior.js'
import { MeridianDb } from '../meridian-db.js'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('MeridianBehavior', () => {
  let db: MeridianDb
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'meridian-behavior-'))
    db = new MeridianDb(tmpDir)
  })

  afterEach(() => {
    db.close()
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('records co-edit pairs within same turn', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.recordEdit('src/c.ts', 1)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 2)
  })

  it('does not record blacklisted files', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('package.json', 1)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 0)
  })

  it('accumulates weight on repeated co-edits', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.flushCoEdits()

    behavior.recordEdit('src/a.ts', 2)
    behavior.recordEdit('src/b.ts', 2)
    behavior.flushCoEdits()

    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighbors.length, 1)
    assert.ok(neighbors[0]!.weight > 1.0)
  })

  it('computes file boost from co-edit + access heat', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    behavior.flushCoEdits()

    db.recordAccess('src/a.ts')
    db.recordAccess('src/a.ts')

    const boost = behavior.getFileBoost('src/a.ts')
    assert.ok(boost > 0)
  })

  it('flushes on turn change', () => {
    const behavior = new MeridianBehavior(db)
    behavior.recordEdit('src/a.ts', 1)
    behavior.recordEdit('src/b.ts', 1)
    // Turn changes — should auto-flush turn 1
    behavior.recordEdit('src/c.ts', 2)
    behavior.recordEdit('src/d.ts', 2)
    behavior.flushCoEdits()

    const neighborsA = db.getCoEditNeighbors('src/a.ts')
    assert.equal(neighborsA.length, 1)
    assert.equal(neighborsA[0]!.file, 'src/b.ts')

    const neighborsC = db.getCoEditNeighbors('src/c.ts')
    assert.equal(neighborsC.length, 1)
    assert.equal(neighborsC[0]!.file, 'src/d.ts')
  })

  it('pheromone cache contributes to file boost', async () => {
    const mockStigmergy = {
      query: async () => [
        { path: 'src/hot.ts', currentStrength: 0.8 },
      ],
    } as any

    const behavior = new MeridianBehavior(db, mockStigmergy)
    await behavior.refreshPheromoneCache()

    const boost = behavior.getFileBoost('src/hot.ts')
    assert.ok(boost > 0)

    const boostCold = behavior.getFileBoost('src/cold.ts')
    assert.ok(boost > boostCold)
  })

  it('getCoEditEdges filters blacklisted targets', () => {
    const behavior = new MeridianBehavior(db)
    db.recordCoEdit('src/a.ts', 'package.json', 1)
    db.recordCoEdit('src/a.ts', 'src/b.ts', 1)

    const edges = behavior.getCoEditEdges('src/a.ts')
    assert.equal(edges.length, 1)
    assert.equal(edges[0]!.targetFile, 'src/b.ts')
  })

  it('weight cap at 5.0', () => {
    // Record many co-edits to hit the cap
    for (let turn = 1; turn <= 20; turn++) {
      db.recordCoEdit('src/a.ts', 'src/b.ts', turn)
    }
    const neighbors = db.getCoEditNeighbors('src/a.ts')
    assert.ok(neighbors[0]!.weight <= 5.0)
  })
})
