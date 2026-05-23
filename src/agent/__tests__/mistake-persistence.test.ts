import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MeridianDb } from '../../repo/meridian-db.js'
import type { MistakeEntry } from '../mistake-notebook.js'

describe('MistakeNotebook SQLite persistence', () => {
  let tmpDir: string
  let dbPath: string

  before(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'mistake-persist-'))
    dbPath = join(tmpDir, 'test.db')
  })

  after(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it('round-trips mistake entries through SQLite', () => {
    const db = new MeridianDb(dbPath)
    const entries: MistakeEntry[] = [
      {
        id: 'abc123',
        timestamp: '2026-05-24',
        error: 'ENOENT: no such file',
        context: 'file: foo.ts',
        resolution: 'use list_dir first',
        tags: ['filesystem', 'read'],
      },
      {
        id: 'def456',
        timestamp: '2026-05-24',
        error: 'permission denied',
        context: 'file: /etc/passwd',
        resolution: 'never read system files',
        tags: ['security'],
      },
    ]

    db.saveMistakeEntries(entries)
    const loaded = db.loadMistakeEntries()
    db.close()

    assert.equal(loaded.length, 2)
    assert.equal(loaded[0]!.id, 'abc123')
    assert.deepEqual(loaded[0]!.tags, ['filesystem', 'read'])
    assert.equal(loaded[1]!.error, 'permission denied')
  })

  it('replaces all entries on save (snapshot semantics, not append)', () => {
    const db = new MeridianDb(dbPath)
    db.saveMistakeEntries([{
      id: 'first', timestamp: '2026-05-24', error: 'e1',
      context: 'c1', resolution: 'r1', tags: [],
    }])
    db.saveMistakeEntries([{
      id: 'second', timestamp: '2026-05-24', error: 'e2',
      context: 'c2', resolution: 'r2', tags: [],
    }])
    const loaded = db.loadMistakeEntries()
    db.close()

    assert.equal(loaded.length, 1)
    assert.equal(loaded[0]!.id, 'second')
  })

  it('returns empty array on fresh db', () => {
    const fresh = mkdtempSync(join(tmpdir(), 'mistake-fresh-'))
    const db = new MeridianDb(join(fresh, 'fresh.db'))
    const loaded = db.loadMistakeEntries()
    db.close()
    rmSync(fresh, { recursive: true, force: true })

    assert.deepEqual(loaded, [])
  })
})
