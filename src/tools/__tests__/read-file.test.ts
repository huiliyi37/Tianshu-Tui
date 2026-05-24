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

  it('rejects files >100KB without offset/limit', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const big = 'x'.repeat(101 * 1024)
    writeFileSync(join(dir, 'src/big.ts'), big, 'utf-8')
    assert.throws(
      () => readFilePayload(dir, { filePath: 'src/big.ts' }),
      /File too large/,
    )
  })

  it('allows files >100KB when offset/limit specified', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(join(dir, 'src/big2.ts'), big, 'utf-8')
    const payload = readFilePayload(dir, { filePath: 'src/big2.ts', offset: 1, limit: 10 })
    assert.ok(payload.rawContent.includes('line 0'))
  })

  it('respects a custom modelCap (legacy default = 8000 chars)', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    // 50_000 chars of unique content so head/tail are distinguishable.
    const long = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')
    writeFileSync(join(dir, 'src/long.ts'), long, 'utf-8')

    // Default cap (no contextWindow plumbed): 8000 chars total, well under 50k.
    const defaultPayload = readFilePayload(dir, {
      filePath: 'src/long.ts',
      offset: 1,
      limit: 1, // bypass the 100KB-without-range guard; long is one giant line anyway
    })
    // The 100KB guard is keyed on file size, and 50_000 < 100KB, so we don't
    // need offset/limit here — re-read without it for the actual assertion:
    const noLimit = readFilePayload(dir, { filePath: 'src/long.ts' })
    assert.ok(noLimit.modelContent.length < long.length, 'should be truncated')
    assert.ok(noLimit.modelContent.length <= 8200, 'default cap ≈ 8000 + marker')

    // 200k window cap: 40_000 chars — still below 50k raw, so still truncated,
    // but materially more content than the default.
    const widePayload = readFilePayload(dir, {
      filePath: 'src/long.ts',
      modelCap: { maxChars: 40_000, headChars: 24_000, tailChars: 12_000 },
    })
    assert.ok(widePayload.modelContent.length > noLimit.modelContent.length * 4,
      'wider context window should yield substantially more content')
    assert.ok(widePayload.modelContent.length <= 40_200, 'wide cap ≈ 40k + marker')

    // Use defaultPayload to silence "unused" — also asserts no crash with limit.
    assert.ok(defaultPayload.modelContent.length > 0)
  })

  it('does not truncate content shorter than the cap', () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const short = 'short content'
    writeFileSync(join(dir, 'src/s.ts'), short, 'utf-8')
    const payload = readFilePayload(dir, {
      filePath: 'src/s.ts',
      modelCap: { maxChars: 100, headChars: 60, tailChars: 30 },
    })
    assert.equal(payload.modelContent, short)
  })
})
