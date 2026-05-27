import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests } from '../read-file.js'
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

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-dedup-'))
    artifactStore = new ArtifactStore(dir, 'test-session')
    __resetReadHistoryForTests()
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
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
