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

  it('rejects path traversal outside cwd', async () => {
    const outside = join(tmpdir(), `outside-${Date.now()}.md`)
    writeFileSync(outside, 'secret', 'utf-8')
    try {
      await assert.rejects(
        async () => readFilePayload(dir, { filePath: 'src/../../outside.md' }),
        /outside project directory/i,
      )
    } finally {
      rmSync(outside, { force: true })
    }
  })

  it('rejects gitignored files', async () => {
    mkdirSync(join(dir, 'node_modules'), { recursive: true })
    writeFileSync(join(dir, 'node_modules/pkg.js'), 'module.exports = 1', 'utf-8')
    await assert.rejects(
      async () => readFilePayload(dir, { filePath: 'node_modules/pkg.js' }),
      /gitignored/i,
    )
  })

  it('returns canonical path and truncated model content for large files', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const long = 'a'.repeat(12_000)
    writeFileSync(join(dir, 'src/a.ts'), long, 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'src/a.ts' })
    assert.equal(payload.canonicalPath, join(dir, 'src/a.ts'))
    assert.ok(payload.modelContent.length < long.length)
    assert.ok(payload.uiContent.includes('1│'))
  })

  it('returns raw content for small files', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/small.ts'), 'hello\nworld\n', 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'src/small.ts' })
    assert.equal(payload.rawContent, 'hello\nworld\n')
    assert.ok(payload.modelContent.includes('hello'))
  })

  it('rejects files >100KB without offset/limit', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const big = 'x'.repeat(101 * 1024)
    writeFileSync(join(dir, 'src/big.ts'), big, 'utf-8')
    await assert.rejects(
      async () => readFilePayload(dir, { filePath: 'src/big.ts' }),
      /File too large/,
    )
  })

  it('allows files >100KB when offset/limit specified', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const big = Array.from({ length: 2000 }, (_, i) => `line ${i}`).join('\n')
    writeFileSync(join(dir, 'src/big2.ts'), big, 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'src/big2.ts', offset: 1, limit: 10 })
    assert.ok(payload.rawContent.includes('line 0'))
  })

  it('respects a custom modelCap (legacy default = 8000 chars)', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    // 50_000 chars of unique content so head/tail are distinguishable.
    const long = Array.from({ length: 50_000 }, (_, i) => String.fromCharCode(33 + (i % 90))).join('')
    writeFileSync(join(dir, 'src/long.ts'), long, 'utf-8')

    // Default cap (no contextWindow plumbed): 8000 chars total, well under 50k.
    const defaultPayload = await readFilePayload(dir, {
      filePath: 'src/long.ts',
      offset: 1,
      limit: 1, // bypass the 100KB-without-range guard; long is one giant line anyway
    })
    // The 100KB guard is keyed on file size, and 50_000 < 100KB, so we don't
    // need offset/limit here — re-read without it for the actual assertion:
    const noLimit = await readFilePayload(dir, { filePath: 'src/long.ts' })
    assert.ok(noLimit.modelContent.length < long.length, 'should be truncated')
    assert.ok(noLimit.modelContent.length <= 8200, 'default cap ≈ 8000 + marker')

    // 200k window cap: 40_000 chars — still below 50k raw, so still truncated,
    // but materially more content than the default.
    const widePayload = await readFilePayload(dir, {
      filePath: 'src/long.ts',
      modelCap: { maxChars: 40_000, headChars: 24_000, tailChars: 12_000 },
    })
    assert.ok(widePayload.modelContent.length > noLimit.modelContent.length * 4,
      'wider context window should yield substantially more content')
    assert.ok(widePayload.modelContent.length <= 40_200, 'wide cap ≈ 40k + marker')

    // Use defaultPayload to silence "unused" — also asserts no crash with limit.
    assert.ok(defaultPayload.modelContent.length > 0)
  })

  it('guards first full reads of large log-like files with a head/tail preview', async () => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    const log = Array.from({ length: 500 }, (_, i) => `event ${i} ${'x'.repeat(80)}`).join('\n')
    writeFileSync(join(dir, 'logs/app.log'), log, 'utf-8')

    const payload = await readFilePayload(dir, { filePath: 'logs/app.log' })

    assert.equal(payload.rawContent, log)
    assert.ok(payload.modelContent.includes('looks like a log/JSONL output file'))
    assert.ok(payload.modelContent.includes('bounded preview only'))
    assert.ok(payload.modelContent.includes('Preview boundaries: head offset=1 limit=80; tail offset=421 limit=80'))
    assert.ok(payload.modelContent.includes('offset=<known line>, limit<=200'))
    assert.ok(payload.modelContent.includes('Do not scan the whole project for this log'))
    assert.ok(payload.modelContent.includes('event 0'))
    assert.ok(payload.modelContent.includes('event 499'))
    assert.ok(payload.modelContent.length < log.length, 'model should only receive preview, not full log')
  })

  it('allows explicit ranges for large log-like files', async () => {
    mkdirSync(join(dir, 'logs'), { recursive: true })
    const log = Array.from({ length: 500 }, (_, i) => `event ${i} ${'x'.repeat(80)}`).join('\n')
    writeFileSync(join(dir, 'logs/app.jsonl'), log, 'utf-8')

    const payload = await readFilePayload(dir, { filePath: 'logs/app.jsonl', offset: 200, limit: 3 })

    assert.ok(payload.modelContent.includes('event 199'))
    assert.ok(payload.modelContent.includes('event 201'))
    assert.ok(!payload.modelContent.includes('looks like a log/JSONL output file'))
  })

  it('keeps existing gitignore guard precedence for generated minified files', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src/app.min.js'), 'x'.repeat(20_000), 'utf-8')
    await assert.rejects(
      () => readFilePayload(dir, { filePath: 'src/app.min.js' }),
      /gitignored/,
    )
  })

  it('does not truncate content shorter than the cap', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const short = 'short content'
    writeFileSync(join(dir, 'src/s.ts'), short, 'utf-8')
    const payload = await readFilePayload(dir, {
      filePath: 'src/s.ts',
      modelCap: { maxChars: 100, headChars: 60, tailChars: 30 },
    })
    assert.equal(payload.modelContent, short)
  })
})

describe('READ_FILE_TOOL multi-read', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-multi-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'a.ts'), 'const a = 1\n', 'utf-8')
    writeFileSync(join(dir, 'src', 'b.ts'), 'const b = 2\n', 'utf-8')
    writeFileSync(join(dir, 'src', 'c.ts'), 'const c = 3\n', 'utf-8')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('reads multiple files via file_paths parameter', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_paths: ['src/a.ts', 'src/b.ts'] },
      toolUseId: 'test',
      cwd: dir,
    })
    assert.ok(!result.isError)
    assert.match(result.content, /const a = 1/)
    assert.match(result.content, /const b = 2/)
    assert.match(result.content, /── src\/a\.ts ──/)
    assert.match(result.content, /── src\/b\.ts ──/)
  })

  it('reads 3 files with sections separated', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_paths: ['src/a.ts', 'src/b.ts', 'src/c.ts'] },
      toolUseId: 'test',
      cwd: dir,
    })
    assert.ok(!result.isError)
    assert.match(result.content, /const a = 1/)
    assert.match(result.content, /const b = 2/)
    assert.match(result.content, /const c = 3/)
  })

  it('handles mixed valid and invalid paths', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_paths: ['src/a.ts', 'src/nonexistent.ts'] },
      toolUseId: 'test',
      cwd: dir,
    })
    // Should succeed overall but contain an error for the missing file
    assert.match(result.content, /const a = 1/)
    assert.match(result.content, /Error:/)
  })

  it('falls back to single file_path when file_paths is not provided', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/a.ts' },
      toolUseId: 'test',
      cwd: dir,
    })
    assert.ok(!result.isError)
    assert.match(result.content, /const a = 1/)
  })
})

