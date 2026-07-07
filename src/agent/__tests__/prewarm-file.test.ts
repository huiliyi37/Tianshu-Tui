import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrewarmCache } from '../prewarm.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPrewarmValue, canUsePrewarmForRead, batchPrewarm, consumePrewarm } from '../prewarm-file.js'

describe('buildPrewarmValue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-'))
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined for path traversal', async () => {
    const value = await buildPrewarmValue(dir, 'src/../../outside.md')
    assert.equal(value, undefined)
  })

  it('returns undefined for gitignored files', async () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg.js'), 'module.exports = 1', 'utf-8')
    const value = await buildPrewarmValue(dir, 'node_modules/pkg.js')
    assert.equal(value, undefined)
  })

  it('returns canonical key and model content for safe small file', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n', 'utf-8')
    const value = await buildPrewarmValue(dir, 'src/a.ts')
    assert.ok(value)
    assert.equal(value.canonicalPath, join(dir, 'src/a.ts'))
    assert.ok(value.content.includes('export const a = 1'))
    assert.ok(value.uiContent.includes('1│'))
  })

  it('returns undefined for non-existent files', async () => {
    const value = await buildPrewarmValue(dir, 'nope.ts')
    assert.equal(value, undefined)
  })
})

describe('canUsePrewarmForRead', () => {
  it('allows full file reads only', async () => {
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts' }), true)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', offset: 2 }), false)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', limit: 10 }), false)
  })

  it('rejects when file_path is missing', async () => {
    assert.equal(canUsePrewarmForRead({}), false)
    assert.equal(canUsePrewarmForRead({ file_path: 42 }), false)
  })
})


it('batchPrewarm caches up to five files and skips existing entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-batch-'))
  try {
    for (let i = 0; i < 7; i++) writeFileSync(join(dir, `file-${i}.txt`), `content ${i}`)
    const cache = new PrewarmCache(60_000, 50)
    const existing = await buildPrewarmValue(dir, 'file-0.txt')
    if (existing) cache.set(existing.canonicalPath, existing)

    await batchPrewarm(dir, Array.from({ length: 7 }, (_, i) => `file-${i}.txt`), cache)

    let present = 0
    for (let i = 0; i < 7; i++) {
      const value = await buildPrewarmValue(dir, `file-${i}.txt`)
      if (value && cache.get(value.canonicalPath)) present++
    }
    assert.equal(present, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe('consumePrewarm', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'prewarm-consume-'))
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns cached full content when mtime matches', async () => {
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n')
    const cache = new PrewarmCache()
    const value = await buildPrewarmValue(dir, 'a.ts')
    assert.ok(value)
    cache.set(value.canonicalPath, value)
    const hit = consumePrewarm(cache, value.canonicalPath)
    assert.ok(hit, 'expected a prewarm hit')
    assert.ok(hit.content.includes('export const a = 1'))
  })

  it('returns null on miss (never prewarmed)', () => {
    const cache = new PrewarmCache()
    assert.equal(consumePrewarm(cache, join(dir, 'absent.ts')), null)
  })

  it('returns null and invalidates after external edit (mtime change)', async () => {
    writeFileSync(join(dir, 'b.ts'), 'v1\n')
    const cache = new PrewarmCache()
    const value = await buildPrewarmValue(dir, 'b.ts')
    assert.ok(value)
    cache.set(value.canonicalPath, value)
    // Force an mtime bump: coarse-resolution filesystems need a delay.
    await new Promise<void>(resolve => setTimeout(resolve, 1100))
    writeFileSync(join(dir, 'b.ts'), 'v2\n')
    assert.equal(consumePrewarm(cache, value.canonicalPath), null)
    // The stale entry should have been invalidated.
    assert.equal(cache.has(value.canonicalPath), false)
  })

  it('returns null when size changed even if mtime is identical (coarse-mtime filesystems)', async () => {
    writeFileSync(join(dir, 'c.ts'), 'vvvv1\n')
    const cache = new PrewarmCache()
    const value = await buildPrewarmValue(dir, 'c.ts')
    assert.ok(value)
    // Simulate an exFAT-style same-timestamp edit: fake the cached entry's
    // sizeBytes so it diverges from the live file while mtime still matches.
    cache.set(value.canonicalPath, { ...value, sizeBytes: value.sizeBytes + 7 })
    assert.equal(consumePrewarm(cache, value.canonicalPath), null, 'size mismatch must not serve cached content')
    assert.equal(cache.has(value.canonicalPath), false, 'stale entry must be invalidated')
  })
})
