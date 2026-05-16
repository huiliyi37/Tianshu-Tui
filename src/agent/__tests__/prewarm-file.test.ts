import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { PrewarmCache } from '../prewarm.js'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { buildPrewarmValue, canUsePrewarmForRead, batchPrewarm } from '../prewarm-file.js'

describe('buildPrewarmValue', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-'))
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('returns undefined for path traversal', () => {
    const value = buildPrewarmValue(dir, 'src/../../outside.md')
    assert.equal(value, undefined)
  })

  it('returns undefined for gitignored files', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg.js'), 'module.exports = 1', 'utf-8')
    const value = buildPrewarmValue(dir, 'node_modules/pkg.js')
    assert.equal(value, undefined)
  })

  it('returns canonical key and model content for safe small file', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/a.ts'), 'export const a = 1\n', 'utf-8')
    const value = buildPrewarmValue(dir, 'src/a.ts')
    assert.ok(value)
    assert.equal(value.canonicalPath, join(dir, 'src/a.ts'))
    assert.ok(value.content.includes('export const a = 1'))
    assert.ok(value.uiContent.includes('1│'))
  })

  it('returns undefined for non-existent files', () => {
    const value = buildPrewarmValue(dir, 'nope.ts')
    assert.equal(value, undefined)
  })
})

describe('canUsePrewarmForRead', () => {
  it('allows full file reads only', () => {
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts' }), true)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', offset: 2 }), false)
    assert.equal(canUsePrewarmForRead({ file_path: 'src/a.ts', limit: 10 }), false)
  })

  it('rejects when file_path is missing', () => {
    assert.equal(canUsePrewarmForRead({}), false)
    assert.equal(canUsePrewarmForRead({ file_path: 42 }), false)
  })
})


it('batchPrewarm caches up to five files and skips existing entries', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-prewarm-batch-'))
  try {
    for (let i = 0; i < 7; i++) writeFileSync(join(dir, `file-${i}.txt`), `content ${i}`)
    const cache = new PrewarmCache(60_000, 50)
    const existing = buildPrewarmValue(dir, 'file-0.txt')!
    cache.set(existing.canonicalPath, existing)

    await batchPrewarm(dir, Array.from({ length: 7 }, (_, i) => `file-${i}.txt`), cache)

    let present = 0
    for (let i = 0; i < 7; i++) {
      const value = buildPrewarmValue(dir, `file-${i}.txt`)!
      if (cache.get(value.canonicalPath)) present++
    }
    assert.equal(present, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
