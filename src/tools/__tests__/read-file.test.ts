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

  it('allows reading gitignored files under .rivet/ (agent state dir)', async () => {
    // Plan mode makes .rivet/plans/draft-*.md the only writable file while it
    // is gitignored — blocking reads on it deadlocks plan revision.
    writeFileSync(join(dir, '.gitignore'), '.rivet/plans/draft-*.md\n', 'utf-8')
    mkdirSync(join(dir, '.rivet/plans'), { recursive: true })
    writeFileSync(join(dir, '.rivet/plans/draft-123.md'), '# Draft\n正文内容。\n', 'utf-8')
    const payload = await readFilePayload(dir, { filePath: '.rivet/plans/draft-123.md' })
    assert.ok(payload.rawContent.includes('正文内容'))
  })

  it('allows reading gitignored files under docs/superpowers/ (design docs)', async () => {
    // Session 5268cce4: specs are gitignored but are critical design documents.
    // Blocking reads on them forces the agent to use bash workarounds.
    writeFileSync(join(dir, '.gitignore'), 'docs/superpowers/specs/*.md\n', 'utf-8')
    mkdirSync(join(dir, 'docs/superpowers/specs'), { recursive: true })
    writeFileSync(join(dir, 'docs/superpowers/specs/analysis.md'), '# Analysis\n根因分析。\n', 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'docs/superpowers/specs/analysis.md' })
    assert.ok(payload.rawContent.includes('根因分析'))
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

  it('returns PARTIAL view for source files >100KB without offset/limit', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const big = Array.from({ length: 3000 }, (_, i) => `line-${i}-${'x'.repeat(40)}`).join('\n')
    writeFileSync(join(dir, 'src/big.ts'), big, 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'src/big.ts' })
    assert.ok(payload.modelContent.includes('PARTIAL view'), 'should contain PARTIAL view header')
    assert.ok(payload.modelContent.includes('line-0-'), 'should contain first line')
    assert.ok(payload.modelContent.includes('To read more:'), 'should contain navigation hint')
  })

  it('returns PARTIAL view for medium-large source files under 100KB', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    // ~90KB — over SOURCE_LARGE_BYTES (80KB) but under MAX_TOOL_INPUT_BYTES (100KB)
    const lines = Array.from({ length: 1500 }, (_, i) => `const val_${i} = ${i}; // ${'x'.repeat(50)}`)
    const content = lines.join('\n')
    writeFileSync(join(dir, 'src/medium-large.ts'), content, 'utf-8')
    const payload = await readFilePayload(dir, { filePath: 'src/medium-large.ts' })
    assert.ok(payload.modelContent.includes('PARTIAL view'), 'should use PARTIAL view for large source')
    assert.ok(payload.modelContent.includes('const val_0'), 'should contain first line')
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

  it('returns focused source ranges when a task query is provided', async () => {
    mkdirSync(join(dir, 'src'), { recursive: true })
    const source = [
      'export function unrelatedHelper(): string {',
      '  return "noise".repeat(20)',
      '}',
      '',
      'export function targetDispatch(): string {',
      '  return "dispatch"',
      '}',
      '',
      'export function unrelatedTail(): number {',
      '  return 42',
      '}',
    ].join('\n')
    writeFileSync(join(dir, 'src/focused.ts'), source, 'utf-8')

    const payload = await readFilePayload(dir, {
      filePath: 'src/focused.ts',
      focus: 'target dispatch',
      modelCap: { maxChars: 1_200, headChars: 800, tailChars: 200 },
    })

    assert.equal(payload.rawContent, source, 'focused reads must retain full raw content for artifact recovery')
    assert.match(payload.modelContent, /\[focused-read\]/)
    assert.match(payload.modelContent, /targetDispatch/)
    assert.ok(!payload.modelContent.includes('return 42'), 'unrelated body should be omitted')
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

  it('re-evaluates focus queries instead of serving a stale read-ref', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    writeFileSync(join(dir, 'src', 'focus.ts'), [
      'export function alpha(): string {',
      '  return "alpha".repeat(20)',
      '}',
      '',
      'export function beta(): string {',
      '  return "beta".repeat(20)',
      '}',
    ].join('\n'), 'utf-8')

    const sessionId = `focused-read-${Date.now()}`
    const first = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/focus.ts', focus: 'alpha' },
      toolUseId: 'focus-1',
      cwd: dir,
      sessionId,
    })
    const second = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/focus.ts', focus: 'beta' },
      toolUseId: 'focus-2',
      cwd: dir,
      sessionId,
    })

    assert.match(first.content, /alpha/)
    assert.match(second.content, /beta/)
    assert.doesNotMatch(second.content, /\[read-ref\]/)
  })
})

describe('readCapOverride (2026-07-24 worker max-turns 诊断)', () => {
  let dir: string
  // ~30KB 源文件:policy 判 full-with-hint(20-80KB),主控 120K cap 下全量返回,
  // worker 紧 cap 下必须降级为 PARTIAL 骨架而非原样占满历史。
  const bigSource = Array.from({ length: 800 }, (_, i) =>
    `export function handler${i}(input: string): string {\n  return input + '${i}'\n}\n`,
  ).join('')

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-readcap-'))
    mkdirSync(join(dir, 'src'), { recursive: true })
    writeFileSync(join(dir, 'src', 'big.ts'), bigSource, 'utf-8')
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  it('无 override 时 1M 窗口全量返回（主控行为不变）', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/big.ts' },
      toolUseId: 'test',
      cwd: dir,
      contextWindow: 1_000_000,
      sessionId: `readcap-a-${Date.now()}`,
    })
    assert.ok(!result.isError)
    assert.match(result.content, /handler799/, 'full content retained on the primary path')
  })

  it('紧 override 下超 cap 全量读降级为 PARTIAL 骨架（不再原样占满 worker 历史）', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/big.ts' },
      toolUseId: 'test',
      cwd: dir,
      contextWindow: 1_000_000,
      sessionId: `readcap-b-${Date.now()}`,
      readCapOverride: { maxChars: 4_000, headChars: 2_400, tailChars: 1_200 },
    })
    assert.ok(!result.isError)
    assert.match(result.content, /── SKELETON view of/, 'fold-then-partial skeleton served')
    assert.ok(result.content.length < bigSource.length / 2, `content bounded (got ${result.content.length} of ${bigSource.length})`)
  })

  // A worker that reads a long plan document gets the fold skeleton. If the header
  // reports the skeleton's own size ("79 lines … showing lines 1-79 of 79") the model
  // reads it as the whole file and silently executes against stripped instructions —
  // this is how the D6 migration lost its user_version guard (2026-08-02).
  it('骨架头部报原文尺寸并声明正文已移除，不伪装成完整文件', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/big.ts' },
      toolUseId: 'test',
      cwd: dir,
      contextWindow: 1_000_000,
      sessionId: `readcap-d-${Date.now()}`,
      readCapOverride: { maxChars: 4_000, headChars: 2_400, tailChars: 1_200 },
    })
    assert.ok(!result.isError)
    const realLines = bigSource.split('\n').length
    assert.match(result.content, new RegExp(`\\(${realLines} lines, ${bigSource.length} chars\\)`),
      '头部必须报原文行数/字符数，不是骨架自己的')
    assert.match(result.content, /NOT the file's text/, '必须明说这不是文件正文')
    assert.match(result.content, /REMOVED/, '必须明说正文已被移除')
    assert.doesNotMatch(result.content, /Showing lines 1-\d+ of \d+\./,
      '不得出现「显示 1-N 共 N 行」这种读起来像完整文件的措辞')
    assert.match(result.content, /offset=1, limit=200/, '必须指向从头精读而非跳过已"看过"的部分')
  })

  it('override 不影响显式 offset/limit 精读', async () => {
    const { READ_FILE_TOOL } = await import('../read-file.js')
    const result = await READ_FILE_TOOL.execute({
      input: { file_path: 'src/big.ts', offset: 1, limit: 3 },
      toolUseId: 'test',
      cwd: dir,
      contextWindow: 1_000_000,
      sessionId: `readcap-c-${Date.now()}`,
      readCapOverride: { maxChars: 4_000, headChars: 2_400, tailChars: 1_200 },
    })
    assert.ok(!result.isError)
    assert.match(result.content, /handler0/)
    assert.doesNotMatch(result.content, /── PARTIAL view of/)
  })
})
