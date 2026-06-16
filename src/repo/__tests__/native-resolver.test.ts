import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)

describe('native-resolver', () => {
  it('returns Database constructor when node_modules has better-sqlite3 (dev mode)', () => {
    // In dev mode, import.meta.url points to source — node_modules is on the
    // resolution path.
    const db = resolveBetterSqlite3(import.meta.url)
    assert.ok(db, 'should return a truthy constructor')
    // Verify it is a real Database by creating an in-memory DB
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(42)
    const row = instance.prepare('SELECT x FROM t').get() as { x: number }
    assert.equal(row.x, 42)
    instance.close()
  })

  it('returns null when neither native/ nor node_modules has better-sqlite3', () => {
    // A URL that resolves to a nonexistent location — no native/ dir, no node_modules
    const fakeUrl = 'file:///nonexistent/path/to/module.js'
    const result = resolveBetterSqlite3(fakeUrl)
    assert.equal(result, null, 'should return null when not found')
  })

  it('loads from dist/native/ when present (production bundle simulation)', (t) => {
    // Simulate running from dist/ — native/ dir is packed alongside main.js
    const distMainUrl = pathToFileURL(process.cwd() + '/dist/main.js').href
    if (!existsSync(process.cwd() + '/dist/native/better_sqlite3.node')) {
      // pack-native.sh not run yet — skip, not fail
      t.skip('dist/native/better_sqlite3.node not found — run: bash scripts/pack-native.sh')
      return
    }
    const db = resolveBetterSqlite3(distMainUrl)
    assert.ok(db, 'should load from dist/native/')
    const instance = new db(':memory:')
    instance.close()
  })
})
