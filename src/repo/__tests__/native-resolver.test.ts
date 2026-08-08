import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBetterSqlite3 } from '../native-resolver.js'
import { existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

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
      // pack-native.js not run yet — skip, not fail
      t.skip('dist/native/better_sqlite3.node not found — run: node scripts/pack-native.js')
      return
    }
    const db = resolveBetterSqlite3(distMainUrl)
    assert.ok(db, 'should load via wrapper + nativeBinding')
    // Bound constructor must behave like the real Database (prepare/exec round-trip).
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(7)
    assert.equal((instance.prepare('SELECT x FROM t').get() as { x: number }).x, 7)
    instance.close()
  })

  it('finds the packed native/ from a nested caller (dist is a tsc tree, not a bundle)', () => {
    // Real callers live at dist/repo/meridian-db.js, dist/agent/*.js … while
    // native/ sits at the dist root. A same-directory probe only ever matched
    // dist/main.js, so every real caller fell through to Path 2 and picked up
    // the binary-less staged wrapper — sqlite off everywhere, no error.
    const root = join(tmpdir(), `native-resolver-nested-${process.pid}-${Date.now()}`)
    mkdirSync(join(root, 'native'), { recursive: true })
    mkdirSync(join(root, 'repo'), { recursive: true })
    writeFileSync(join(root, 'native', 'better_sqlite3.node'), 'not a real addon')
    try {
      // The throw IS the assertion that Path 1 matched: tmpdir has no resolvable
      // wrapper, and only Path 1 reports that as a packaging bug. Before the fix
      // this same input returned null.
      assert.throws(
        () => resolveBetterSqlite3(pathToFileURL(join(root, 'repo', 'meridian-db.js')).href),
        (err: unknown) => (err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN',
        'a caller one level down must still see the packed native/',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('resolves from a real dist/<area>/ caller when the bundle is packed', (t) => {
    if (!existsSync(join(process.cwd(), 'dist', 'native', 'better_sqlite3.node'))) {
      t.skip('dist/native/better_sqlite3.node not found — run: node scripts/pack-native.js')
      return
    }
    // Byte-for-byte what meridian-db.js passes as import.meta.url at runtime.
    const url = pathToFileURL(join(process.cwd(), 'dist', 'repo', 'meridian-db.js')).href
    const db = resolveBetterSqlite3(url)
    assert.ok(db, 'nested dist caller must resolve a constructor')
    const instance = new db(':memory:')
    instance.exec('CREATE TABLE t (x INTEGER)')
    instance.prepare('INSERT INTO t VALUES (?)').run(11)
    assert.equal((instance.prepare('SELECT x FROM t').get() as { x: number }).x, 11)
    instance.close()
  })

  it('stops walking up before it can bind an unrelated native/ binary', () => {
    // Walking up is bounded: an ancestor far above the install root is somebody
    // else's, and binding a stranger's .node is worse than not finding one.
    const root = join(tmpdir(), `native-resolver-deep-${process.pid}-${Date.now()}`)
    const deep = join(root, 'a', 'b', 'c', 'd', 'e', 'f', 'g')
    mkdirSync(join(root, 'native'), { recursive: true })
    mkdirSync(deep, { recursive: true })
    writeFileSync(join(root, 'native', 'better_sqlite3.node'), 'not a real addon')
    try {
      assert.equal(
        resolveBetterSqlite3(pathToFileURL(join(deep, 'mod.js')).href),
        null,
        'seven levels up is out of range',
      )
    } finally {
      rmSync(root, { recursive: true, force: true })
    }
  })

  it('throws (no silent degrade) when native binary is present but wrapper is unresolvable', () => {
    // A location OUTSIDE the repo so node module resolution finds no
    // better-sqlite3 — but with a native/ binary present, which is exactly the
    // "broken packaging" signal that must fail loud instead of degrading.
    const dir = join(tmpdir(), `native-resolver-broken-${process.pid}-${Date.now()}`)
    mkdirSync(join(dir, 'native'), { recursive: true })
    writeFileSync(join(dir, 'native', 'better_sqlite3.node'), 'not a real addon')
    const moduleUrl = pathToFileURL(join(dir, 'main.js')).href
    try {
      assert.throws(
        () => resolveBetterSqlite3(moduleUrl),
        (err: unknown) => (err as { code?: string })?.code === 'ESQLITE_BUNDLE_BROKEN',
        'must throw ESQLITE_BUNDLE_BROKEN rather than return a NullDatabase',
      )
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
