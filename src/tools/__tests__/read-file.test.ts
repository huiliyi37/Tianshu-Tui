import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { readFilePayload } from '../read-file.js'

describe('readFilePayload', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-'))
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects path traversal outside cwd', () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.md`)
    writeFileSync(outside, 'secret', 'utf-8')
    try {
      assert.throws(
        () => readFilePayload(dir, { filePath: 'src/../../outside.md' }),
        /outside project directory/i,
      )
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('rejects gitignored files', () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg.js'), 'module.exports = 1', 'utf-8')
    assert.throws(
      () => readFilePayload(dir, { filePath: 'node_modules/pkg.js' }),
      /gitignored/i,
    )
  })

  it('returns canonical path and truncated model content for large files', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const long = 'a'.repeat(12_000)
    writeFileSync(join(dir, 'src/a.ts'), long, 'utf-8')
    const payload = readFilePayload(dir, { filePath: 'src/a.ts' })
    assert.equal(payload.canonicalPath, join(dir, 'src/a.ts'))
    assert.ok(payload.modelContent.length < long.length)
    assert.ok(payload.uiContent.includes('1│'))
  })

  it('returns raw content for small files', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/small.ts'), 'hello\nworld\n', 'utf-8')
    const payload = readFilePayload(dir, { filePath: 'src/small.ts' })
    assert.equal(payload.rawContent, 'hello\nworld\n')
    assert.ok(payload.modelContent.includes('hello'))
  })
})
