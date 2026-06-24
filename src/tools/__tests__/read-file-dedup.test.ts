import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests, isUnchangedRepeatRead, getReadRefStats } from '../read-file.js'
import { ArtifactStore } from '../../artifact/store.js'
import type { ToolCallParams } from '../types.js'

describe('fileReadHistory dedup', () => {
  let dir: string
  let artifactStore: ArtifactStore
  // Use 128K window so artifact threshold is low enough for test files to be artifact-wrapped
  const CTX_WINDOW = 128_000
  const params = (overrides: Partial<ToolCallParams['input']> & { file_path: string }, useArtifact = true): ToolCallParams => ({
    toolUseId: `test-${Math.random().toString(36).slice(2, 8)}`,
    cwd: dir,
    input: overrides as ToolCallParams['input'],
    ...(useArtifact ? { artifactStore, contextWindow: CTX_WINDOW } : {}),
  })

  // This block exercises the fileReadHistory dedup-warning + artifact fragment
  // re-serving paths, which predate (and are orthogonal to) the read-ref feature.
  // read-ref is now default-on (commit 1d55bd95) and would otherwise replace full
  // repeat reads with a [read-ref] pointer — disable it here to isolate this concern.
  const savedReadRef = process.env['RIVET_READ_REF']

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-dedup-'))
    artifactStore = new ArtifactStore(dir, 'test-session')
    __resetReadHistoryForTests()
    process.env['RIVET_READ_REF'] = '0'
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    if (savedReadRef === undefined) delete process.env['RIVET_READ_REF']
    else process.env['RIVET_READ_REF'] = savedReadRef
  })

  function makeFile(name: string, lines: number, lineWidth = 80): string {
    const path = join(dir, name)
    const parent = join(dir, 'src')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`.padEnd(lineWidth, ' ')).join('\n')
    writeFileSync(path, content, 'utf-8')
    return name
  }

  // ── 核心场景 ──

  it('re-serves fragment from artifact after full read of unchanged file', async () => {
    const file = makeFile('src/foo.ts', 100)

    // 1. 全量读取 → 应成功返回完整内容
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'full read must return content')
    assert.ok(r1.content.includes('line 100'), 'full read must include last line')

    // 2. 片段读取 → 应从 artifact 直接返回对应切片
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r2.content.includes('line 50'), 'fragment must return content from artifact')
    assert.ok(!r2.content.includes('line 1'), 'fragment must not return lines before offset')
  })

  it('allows fragment read after full read if file was modified', async () => {
    const file = makeFile('src/foo.ts', 100)
    const absPath = join(dir, file)

    // 1. 全量读取
    await READ_FILE_TOOL.execute(params({ file_path: file }))

    // 2. 修改文件（改变 mtime）
    writeFileSync(absPath, 'modified content\n', 'utf-8')

    // 3. 片段读取 → 应允许（mtime 变了）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 1, limit: 2 }))
    assert.ok(r2.content.includes('modified'), 'fragment read after modification must succeed')
    assert.ok(!r2.content.includes('was already read'), 'must not be blocked')
  })

  it('allows full read after fragment read (fragment does not trigger fileReadHistory)', async () => {
    const file = makeFile('src/foo.ts', 100)

    // 1. 先片段读（不记录到 fileReadHistory）
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r1.content.includes('line 50'), 'fragment read must return content')

    // 2. 全量读 → 应允许（之前只有片段读）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('line 100'), 'full read after fragment must succeed')
  })

  it('repeat full read of same unchanged file returns content normally (no artifactStore)', async () => {
    const file = makeFile('src/foo.ts', 50)

    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }, false))
    assert.ok(r1.content.includes('line 1'), 'first full read must return content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }, false))
    assert.ok(r2.content.includes('line 1'), 'second full read must return content (no artifactStore)')
  })

  // ── 边界场景 ──

  it('different files have independent fileReadHistory', async () => {
    const f1 = makeFile('src/a.ts', 100)
    const f2 = makeFile('src/b.ts', 100)

    // 全量读两个不同的文件
    await READ_FILE_TOOL.execute(params({ file_path: f1 }))
    await READ_FILE_TOOL.execute(params({ file_path: f2 }))

    // 片段读取 f1 → 应从 artifact 返回对应切片
    const r = await READ_FILE_TOOL.execute(params({ file_path: f1, offset: 10, limit: 5 }))
    assert.ok(r.content.includes('line 10'), 'f1 fragment must return content from artifact')
    assert.ok(!r.content.includes('line 1 '), 'f1 fragment must not include earlier lines')
  })

  it('trim evicts oldest entries when exceeding FILE_READ_HISTORY_MAX', async () => {
    for (let i = 0; i < 250; i++) {
      const file = makeFile(`src/mod${i}.ts`, 5, 10)
      await READ_FILE_TOOL.execute(params({ file_path: file }, false))
    }
    const freshFile = makeFile('src/later.ts', 5, 10)
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: freshFile }, false))
    assert.ok(r1.content.includes('line 1'), 'read after trim must still work')
  })
})

describe('isUnchangedRepeatRead (任务 B1)', () => {
  let dir: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-repeat-'))
    __resetReadHistoryForTests()
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function makeFile(name: string, content: string): string {
    const path = join(dir, name)
    const parent = join(dir, 'src')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    writeFileSync(path, content, 'utf-8')
    return path
  }

  it('returns true for exact same offset/limit repeat of unchanged file', async () => {
    const fp = makeFile('src/foo.ts', 'line 1\nline 2\nline 3\n')
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(fp)).mtimeMs
    const dedupKey = `${dir}::${fp}::1::all`

    // First read to populate readHistory
    const r1 = await READ_FILE_TOOL.execute({
      toolUseId: 't1',
      cwd: dir,
      input: { file_path: fp },
      contextWindow: 128_000,
      artifactStore: new (await import('../../artifact/store.js')).ArtifactStore(dir, 'test-b1'),
    })
    assert.ok(r1.content.includes('line 1'))

    // Now check isUnchangedRepeatRead
    assert.equal(isUnchangedRepeatRead(fp, mtime, dedupKey, 1, undefined), true)
  })

  it('returns true for full-read superset match', async () => {
    const fp = makeFile('src/bar.ts', 'a\nb\nc\n')
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(fp)).mtimeMs

    // Full-file read to populate fileReadHistory
    await READ_FILE_TOOL.execute({
      toolUseId: 't2',
      cwd: dir,
      input: { file_path: fp },
      contextWindow: 128_000,
    })

    // New read of same file (offset=1, no limit) → full superset match
    const dedupKey = `${dir}::${fp}::1::all`
    assert.equal(isUnchangedRepeatRead(fp, mtime, dedupKey, 1, undefined), true)
  })

  it('returns false when mtime changed (file was modified)', async () => {
    const fp = makeFile('src/baz.ts', 'old content\n')
    const { stat, writeFile } = await import('node:fs/promises')

    // First read
    await READ_FILE_TOOL.execute({
      toolUseId: 't3',
      cwd: dir,
      input: { file_path: fp },
      contextWindow: 128_000,
    })

    // Modify the file
    await writeFile(fp, 'new content\n', 'utf-8')
    const newMtime = (await stat(fp)).mtimeMs
    const dedupKey = `${dir}::${fp}::1::all`

    assert.equal(isUnchangedRepeatRead(fp, newMtime, dedupKey, 1, undefined), false)
  })

  it('returns false for first read (not in history)', () => {
    assert.equal(isUnchangedRepeatRead('/nope', Date.now(), '/nope::1::all', 1, undefined), false)
  })

  it('returns false when offset differs from prior read', async () => {
    const fp = makeFile('src/qux.ts', '1\n2\n3\n4\n5\n')
    const { stat } = await import('node:fs/promises')
    const mtime = (await stat(fp)).mtimeMs

    // Read offset=1, limit=2
    await READ_FILE_TOOL.execute({
      toolUseId: 't4',
      cwd: dir,
      input: { file_path: fp, offset: 1, limit: 2 },
      contextWindow: 128_000,
    })

    // New read: offset=3, limit=2 — different dedup key
    const newDedupKey = `${dir}::${fp}::3::2`
    assert.equal(isUnchangedRepeatRead(fp, mtime, newDedupKey, 3, 2), false)
  })
})

// B2 read-ref tests — dynamically toggle RIVET_READ_REF per test.
describe('read-ref compact reference (任务 B2)', () => {
  const savedEnv = process.env['RIVET_READ_REF']
  let dir: string

  function enableReadRef(): void {
    process.env['RIVET_READ_REF'] = '1'
  }

  function disableReadRef(): void {
    // read-ref is default-on (opt-out with =0, commit 1d55bd95); deleting the var
    // would leave it ENABLED. Must explicitly set '0' to disable.
    process.env['RIVET_READ_REF'] = '0'
  }

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-ref-'))
    __resetReadHistoryForTests()
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
    // Restore original env
    if (savedEnv === undefined) {
      delete process.env['RIVET_READ_REF']
    } else {
      process.env['RIVET_READ_REF'] = savedEnv
    }
  })

  function makeFile(name: string, lines: number, lineWidth = 80): string {
    const path = join(dir, name)
    const parent = join(dir, 'src')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`.padEnd(lineWidth, ' ')).join('\n')
    writeFileSync(path, content, 'utf-8')
    return name
  }

  function params(overrides: Partial<{ file_path: string; offset: number; limit: number }>, useArtifact = false): ToolCallParams {
    return {
      toolUseId: `test-ref-${Math.random().toString(36).slice(2, 6)}`,
      cwd: dir,
      input: overrides as ToolCallParams['input'],
      ...(useArtifact ? {
        artifactStore: new ArtifactStore(dir, 'test-ref'),
        contextWindow: 128_000,
      } : { contextWindow: 1_000_000 }),
    }
  }

  it('flag off: repeat full read returns full content (regression guard)', async () => {
    disableReadRef()
    const file = makeFile('src/keep.ts', 100)
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'first read must return content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('line 1'), 'second read must also return content')
    assert.ok(!r2.content.startsWith('[read-ref]'), 'must not return reference when flag is off')
  })

  it('flag on: repeat full read returns [read-ref] without full content', async () => {
    enableReadRef()
    const file = makeFile('src/ref.ts', 100)
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'first read must return content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.startsWith('[read-ref]'), 'second read must return reference')
    assert.ok(!r2.content.includes('line 1'), 'reference must not include file content')
  })

  it('flag on: modified file returns full content not reference', async () => {
    enableReadRef()
    const file = makeFile('src/mod.ts', 100)
    const absPath = join(dir, file)

    await READ_FILE_TOOL.execute(params({ file_path: file }))

    // Modify file
    writeFileSync(absPath, 'new content\n'.repeat(50), 'utf-8')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('new content'), 'modified file must return full content')
    assert.ok(!r2.content.startsWith('[read-ref]'), 'must not return reference for modified file')
  })

  it('flag on: small fragment below threshold returns content not reference', async () => {
    enableReadRef()
    // File with ~1KB content (below 2KB threshold)
    const file = makeFile('src/small.ts', 10, 50)
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'))

    // Repeat read should still return content (because it's below threshold)
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('line 1'), 'small repeat must return content')
    assert.ok(!r2.content.startsWith('[read-ref]'), 'must not reference small fragments')
  })

  it('flag on: readRef counter increments', async () => {
    enableReadRef()
    const file = makeFile('src/count.ts', 100)
    const statsBefore = getReadRefStats()

    await READ_FILE_TOOL.execute(params({ file_path: file })) // first read
    await READ_FILE_TOOL.execute(params({ file_path: file })) // repeat → ref

    const statsAfter = getReadRefStats()
    assert.ok(statsAfter.count > statsBefore.count, 'readRefCount must increment')
    assert.ok(statsAfter.savedBytes > statsBefore.savedBytes, 'readRefSavedBytes must increase')
  })
})
