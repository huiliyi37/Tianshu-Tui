import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeridianDb } from '../../repo/meridian-db.js'
import type { ImmuneMemory } from '../immune-types.js'

describe('MeridianDb immune memory persistence', () => {
  it('round-trips immune memories through DB', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const memory: ImmuneMemory = {
        id: 'abc123',
        pattern: 'tool:bash:fp_xyz',
        response: { type: 'quarantine', targetFile: 'src/foo.ts', duration: 20 },
        affinityScore: 0.7,
        hitCount: 3,
        lastHit: 120,
        createdAt: 50,
      }
      db.saveImmuneMemories([memory])
      db.close()

      const db2 = new MeridianDb(dir)
      const loaded = db2.loadImmuneMemories()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.id, 'abc123')
      assert.equal(loaded[0]!.affinityScore, 0.7)
      assert.equal(loaded[0]!.response.type, 'quarantine')
      assert.equal(loaded[0]!.response.targetFile, 'src/foo.ts')
      db2.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('replaces all memories on save (not append)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const m1: ImmuneMemory = {
        id: 'a', pattern: 'p1',
        response: { type: 'deposit_warning', targetFile: 'f1' },
        affinityScore: 0.5, hitCount: 1, lastHit: 1, createdAt: 1,
      }
      const m2: ImmuneMemory = {
        id: 'b', pattern: 'p2',
        response: { type: 'boost_healthy', healthyEdges: [{ fileA: 'a', fileB: 'b' }] },
        affinityScore: 0.6, hitCount: 2, lastHit: 2, createdAt: 2,
      }
      db.saveImmuneMemories([m1, m2])
      db.saveImmuneMemories([m1]) // m2 should be gone
      const loaded = db.loadImmuneMemories()
      assert.equal(loaded.length, 1)
      assert.equal(loaded[0]!.id, 'a')
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('returns empty array when table is fresh', () => {
    const dir = mkdtempSync(join(tmpdir(), 'immune-db-'))
    try {
      const db = new MeridianDb(dir)
      const loaded = db.loadImmuneMemories()
      assert.equal(loaded.length, 0)
      db.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
