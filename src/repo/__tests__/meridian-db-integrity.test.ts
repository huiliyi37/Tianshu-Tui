import { describe, it, test, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { MeridianDb } from '../meridian-db.js'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const ABS_PATH_RE = /^\/|^[A-Za-z]:[\\/]/

describe('meridian db data integrity (D6 task 3)', () => {
  let db: MeridianDb
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'meridian-integrity-'))
    db = new MeridianDb(dir)
  })

  afterEach(() => {
    db.close()
    rmSync(dir, { recursive: true, force: true })
  })

  it('fresh db has no absolute-path rows after normal indexing', () => {
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'h1',
      symbols: [{ id: 'src/a.ts:A:1', name: 'A', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
      calls: [],
    })
    const files = db.getAllFiles()
    assert.ok(files.every(f => !ABS_PATH_RE.test(f)), `absolute-path rows leaked: ${JSON.stringify(files)}`)
    assert.equal(db.schemaVersion(), 1)
  })

  it('all imports edges resolve to an indexed file (no dangling targets)', () => {
    // File-level imports edge whose target matches files.path || ':*:0'
    db.upsertFile({
      filePath: 'src/a.ts',
      contentHash: 'h1',
      symbols: [{ id: 'src/a.ts:A:1', name: 'A', kind: 'function', filePath: 'src/a.ts', line: 1, exported: true, contentHash: 'h1' }],
      edges: [],
      imports: [],
      calls: [],
    })
    db.upsertEdge('src/a.ts:A:1', 'src/a.ts:*:0', 'imports', 1.0)
    db.close()

    const Database = resolveBetterSqlite3(import.meta.url)
    const conn = new Database(join(dir, 'meridian.db'))
    try {
      const dangling = conn.prepare(
        "SELECT COUNT(*) as cnt FROM edges WHERE kind = 'imports' AND NOT EXISTS (SELECT 1 FROM files f WHERE edges.target_id = f.path || ':*:0')",
      ).get() as { cnt: number }
      assert.equal(dangling.cnt, 0, `dangling imports edges found: ${dangling.cnt}`)
    } finally {
      conn.close()
    }
  })
})

// ─── Live DB diagnostics ───
// Reports only. The developer's own .rivet/meridian.db is mutable local state and
// migrates on the next session open, so asserting on it would make this suite red
// on any machine that has not opened a session since v1 landed.
const liveDbPath = join(process.cwd(), '.rivet', 'meridian.db')

test('live meridian.db legacy-row diagnostic', { skip: !existsSync(liveDbPath) }, () => {
  const Database = resolveBetterSqlite3(import.meta.url)
  const conn = new Database(liveDbPath, { readonly: true })
  try {
    const absRows = (conn.prepare("SELECT COUNT(*) as cnt FROM files WHERE path GLOB '/*'").get() as { cnt: number }).cnt
    const version = conn.pragma('user_version', { simple: true }) as number
    console.log(`[meridian-integrity] live db: user_version=${version}, absolute-path rows=${absRows}` +
      (version < 1 ? ' — pre-v1, migrates on the next session open' : ''))
  } finally {
    conn.close()
  }
})
