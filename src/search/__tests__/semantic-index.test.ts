/**
 * Tests for semantic-index.ts — isStale, incrementalUpdate, fallback rebuild.
 */
import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SemanticIndex } from '../semantic-index.js'

const TEST_DIR = join(tmpdir(), 'rivet-si-test')

function setup() {
  if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
  mkdirSync(TEST_DIR, { recursive: true })
  mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
}

function teardown() {
  try { rmSync(TEST_DIR, { recursive: true }) } catch { /* cleanup */ }
}

describe('semantic-index', () => {
  setup()

  it('rebuild indexes source files', () => {
    try { rmSync(join(TEST_DIR, '.rivet'), { recursive: true }) } catch {}
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'hello.ts'), 'export function hello() { return "world" }')
    const idx = new SemanticIndex(TEST_DIR)
    const result = idx.rebuild(10)
    assert.ok(result.indexed >= 1)
    assert.ok(idx.chunkCount > 0)
  })

  it('isStale detects modified files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'stale.ts'), 'const x = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    // Modify the file
    writeFileSync(join(TEST_DIR, 'src', 'stale.ts'), 'const x = 2')
    assert.equal(idx.isStale(), true)
  })

  it('isStale detects new files', () => {
    // Clean snapshot from previous tests
    try { rmSync(join(TEST_DIR, '.rivet'), { recursive: true }) } catch {}
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'a.ts'), 'const a = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    // Add a new file not in the index
    writeFileSync(join(TEST_DIR, 'src', 'b.ts'), 'const b = 2')
    assert.equal(idx.isStale(), true)
  })

  it('isStale detects deleted files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'del.ts'), 'const d = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    rmSync(join(TEST_DIR, 'src', 'del.ts'))
    assert.equal(idx.isStale(), true)
  })

  it('incrementalUpdate reindexes changed files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'inc.ts'), 'const i = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    assert.equal(idx.isStale(), false)

    writeFileSync(join(TEST_DIR, 'src', 'inc.ts'), 'const i = 2')
    const update = idx.incrementalUpdate()
    assert.equal(update.reindexed, 1)
    assert.equal(idx.isStale(), false)
  })

  it('incrementalUpdate removes deleted files', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'rem.ts'), 'const r = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    rmSync(join(TEST_DIR, 'src', 'rem.ts'))
    const update = idx.incrementalUpdate()
    assert.equal(update.removed, 1)
  })

  it('incrementalUpdate falls back to rebuild when >20% changed', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    // Create 6 files
    for (let i = 0; i < 6; i++) {
      writeFileSync(join(TEST_DIR, 'src', `fb${i}.ts`), `const fb${i} = ${i}`)
    }
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    // Delete 2 files (33% change → triggers fallback)
    rmSync(join(TEST_DIR, 'src', 'fb0.ts'))
    rmSync(join(TEST_DIR, 'src', 'fb1.ts'))
    const update = idx.incrementalUpdate()
    assert.equal(update.fallbackRebuild, true)
  })

  it('persistMeta saves and loadMeta restores chunks', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'persist.ts'), 'export const p = 1')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)
    const chunkCount = idx.chunkCount
    assert.ok(chunkCount > 0)

    // Simulate process restart: new SemanticIndex loads from disk
    const idx2 = new SemanticIndex(TEST_DIR)
    assert.equal(idx2.chunkCount, chunkCount) // chunks restored
    assert.equal(idx2.isStale(), false)
  })

  it('search returns results after rebuild', () => {
    mkdirSync(join(TEST_DIR, 'src'), { recursive: true })
    writeFileSync(join(TEST_DIR, 'src', 'searchable.ts'), 'export function authenticateUser(token: string) { return true }')
    const idx = new SemanticIndex(TEST_DIR)
    idx.rebuild(10)

    const hits = idx.search('authenticate user token', 5)
    assert.ok(hits.length >= 1)
    assert.ok(hits[0]!.file.includes('searchable.ts'))
  })

  teardown()
})
