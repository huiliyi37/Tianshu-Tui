import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests, __evictLastKnownForTests, isUnchangedRepeatRead, getReadRefStats, getFileReadMtime, invalidateSessionReadDedup } from '../read-file.js'
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

  it('artifact re-serve re-registers 表2 after eviction (blind-overwrite guard dead-loop prevention)', async () => {
    const file = makeFile('src/reregister.ts', 100)
    // 表 keys use validatePath output, which keeps the caller's cwd form
    // (resolve(cwd, path), NOT realpathSync) — mirror that here.
    const absPath = join(dir, file)

    await READ_FILE_TOOL.execute(params({ file_path: file })) // full read → artifact + 表2
    __evictLastKnownForTests(absPath) // simulate LAST_KNOWN_MAX trimming
    assert.equal(getFileReadMtime(absPath), null, '表2 evicted')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r2.content.includes('line 50'), 'fragment re-served from artifact')
    assert.ok(getFileReadMtime(absPath) !== null, 'artifact shortcut must re-register 表2')
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
    const st = await stat(fp)
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
    assert.equal(isUnchangedRepeatRead(fp, st.mtimeMs, st.size, dedupKey, 1, undefined), true)
  })

  it('returns true for full-read superset match', async () => {
    const fp = makeFile('src/bar.ts', 'a\nb\nc\n')
    const { stat } = await import('node:fs/promises')
    const st = await stat(fp)

    // Full-file read to populate fileReadHistory
    await READ_FILE_TOOL.execute({
      toolUseId: 't2',
      cwd: dir,
      input: { file_path: fp },
      contextWindow: 128_000,
    })

    // New read of same file (offset=1, no limit) → full superset match
    const dedupKey = `${dir}::${fp}::1::all`
    assert.equal(isUnchangedRepeatRead(fp, st.mtimeMs, st.size, dedupKey, 1, undefined), true)
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
    const newStat = await stat(fp)
    const dedupKey = `${dir}::${fp}::1::all`

    assert.equal(isUnchangedRepeatRead(fp, newStat.mtimeMs, newStat.size, dedupKey, 1, undefined), false)
  })

  it('returns false for first read (not in history)', () => {
    assert.equal(isUnchangedRepeatRead('/nope', Date.now(), 100, '/nope::1::all', 1, undefined), false)
  })

  it('returns false when size changed even if mtime is identical (coarse-mtime filesystems)', async () => {
    const fp = makeFile('src/coarse.ts', 'aaaa\nbbbb\ncccc\n')
    const { stat } = await import('node:fs/promises')
    const st = await stat(fp)

    await READ_FILE_TOOL.execute({
      toolUseId: 't-coarse',
      cwd: dir,
      input: { file_path: fp },
      contextWindow: 128_000,
    })

    // Same mtime, different size → must NOT be treated as unchanged
    const dedupKey = `${dir}::${fp}::1::all`
    assert.equal(isUnchangedRepeatRead(fp, st.mtimeMs, st.size + 7, dedupKey, 1, undefined), false)
  })

  it('returns false when offset differs from prior read', async () => {
    const fp = makeFile('src/qux.ts', '1\n2\n3\n4\n5\n')
    const { stat } = await import('node:fs/promises')
    const st = await stat(fp)

    // Read offset=1, limit=2
    await READ_FILE_TOOL.execute({
      toolUseId: 't4',
      cwd: dir,
      input: { file_path: fp, offset: 1, limit: 2 },
      contextWindow: 128_000,
    })

    // New read: offset=3, limit=2 — different dedup key
    const newDedupKey = `${dir}::${fp}::3::2`
    assert.equal(isUnchangedRepeatRead(fp, st.mtimeMs, st.size, newDedupKey, 3, 2), false)
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

  it('flag on: read-ref shortcut re-registers 表2 after eviction (blind-overwrite guard dead-loop prevention)', async () => {
    enableReadRef()
    const file = makeFile('src/evicted.ts', 100)
    // Same cwd-form key rule as the artifact re-serve test above.
    const absPath = join(dir, file)

    await READ_FILE_TOOL.execute(params({ file_path: file })) // first read → 表1 + 表2
    assert.ok(getFileReadMtime(absPath) !== null, '表2 registered by first read')

    // Simulate LAST_KNOWN_MAX trimming: 表2 evicted while 表1 dedup entry survives.
    __evictLastKnownForTests(absPath)
    assert.equal(getFileReadMtime(absPath), null, '表2 evicted')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.startsWith('[read-ref]'), 'repeat read takes the shortcut')
    assert.ok(getFileReadMtime(absPath) !== null, 'shortcut must re-register 表2 — otherwise write_file guard loops forever')
  })

  // ── 压缩失效 + 降级闸门 (2026-07-07 read-ref 修复) ──
  // read-ref 声称「回看上文」，但历史 tool_result 会被压缩/修剪掉。两道防线：
  // ① 压缩重写后 invalidateSessionReadDedup 清表 → 下次读取重发全文；
  // ② 同一条目连续第二次 ref 命中 → 引用没帮上忙，降级为真实读取。

  it('read-ref wording leads with read_section disk read, not "look above"', async () => {
    enableReadRef()
    const file = makeFile('src/wording.ts', 100)
    await READ_FILE_TOOL.execute(params({ file_path: file }))
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.startsWith('[read-ref]'))
    assert.ok(r2.content.includes('read_section(file_path='), 'must offer the disk-backed read_section escape hatch')
    assert.ok(r2.content.includes('不依赖上文'), 'must state read_section works regardless of history state')
  })

  it('second consecutive ref hit degrades to full content, then ref resumes', async () => {
    enableReadRef()
    const file = makeFile('src/degrade.ts', 100)

    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'first read returns content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.startsWith('[read-ref]'), 'first repeat returns the reference')

    // The model came back AGAIN for the same unchanged slice — the ref didn't
    // help (its target may have been pruned from the request view). Degrade.
    const r3 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(!r3.content.startsWith('[read-ref]'), 'second repeat must NOT loop the reference')
    assert.ok(r3.content.includes('line 1'), 'second repeat must re-serve full content')
    assert.ok(r3.content.includes('line 100'), 'full content includes the last line')

    // The degrade re-recorded a fresh dedup entry — the ref gets another chance.
    const r4 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r4.content.startsWith('[read-ref]'), 'ref resumes after a fresh full serve')
  })

  it('invalidateSessionReadDedup clears only the target session; 表2 survives', async () => {
    enableReadRef()
    const file = makeFile('src/invalidate.ts', 100)
    const absPath = join(dir, file)
    const withSession = (sessionId: string): ToolCallParams => ({ ...params({ file_path: file }), sessionId })

    await READ_FILE_TOOL.execute(withSession('s1'))
    await READ_FILE_TOOL.execute(withSession('s2'))

    // History rewrite happened for s1 (compaction) — its dedup records must die.
    invalidateSessionReadDedup('s1')

    const r1 = await READ_FILE_TOOL.execute(withSession('s1'))
    assert.ok(!r1.content.startsWith('[read-ref]'), 's1 repeat after invalidation must re-serve content')
    assert.ok(r1.content.includes('line 1'), 's1 gets full content')

    const r2 = await READ_FILE_TOOL.execute(withSession('s2'))
    assert.ok(r2.content.startsWith('[read-ref]'), 's2 dedup records must survive s1 invalidation')

    // 表2 (lastKnownFileState) tracks FILE state, not history presence — must survive.
    assert.ok(getFileReadMtime(absPath, 's1') !== null, '表2 for s1 must survive invalidation')
  })
})
