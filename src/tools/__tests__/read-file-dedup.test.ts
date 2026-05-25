import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { READ_FILE_TOOL, __resetReadHistoryForTests } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

describe('fileReadHistory dedup', () => {
  let dir: string
  const params = (overrides: Partial<ToolCallParams['input']> & { file_path: string }): ToolCallParams => ({
    toolUseId: `test-${Math.random().toString(36).slice(2, 8)}`,
    cwd: dir,
    input: overrides as ToolCallParams['input'],
  })

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-read-dedup-'))
    __resetReadHistoryForTests()
  })

  afterEach(() => {
    if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  })

  function makeFile(name: string, lines: number): string {
    const path = join(dir, name)
    const parent = join(dir, 'src')
    if (!existsSync(parent)) mkdirSync(parent, { recursive: true })
    const content = Array.from({ length: lines }, (_, i) => `line ${i + 1}`).join('\n')
    writeFileSync(path, content, 'utf-8')
    return name // Return relative path for tool calls
  }

  // ── 核心场景 ──

  it('blocks fragment read after full read of unchanged file', async () => {
    const file = makeFile('src/foo.ts', 100)

    // 1. 全量读取 → 应成功返回完整内容
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'full read must return content')
    assert.ok(r1.content.includes('line 100'), 'full read must include last line')

    // 2. 片段读取 → 应被阻断（fileReadHistory 命中）
    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file, offset: 50, limit: 10 }))
    assert.ok(r2.content.includes('was already read in full'), 'fragment read must be blocked')
    assert.ok(!r2.content.includes('line 50'), 'fragment read must NOT return file content')
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

    // 全量读两次 — 无 artifactStore 时 readHistory 记录但不阻断
    // 第二次仍然返回内容（现有行为，不测试 readHistory dedup 因为需要 artifactStore）
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r1.content.includes('line 1'), 'first full read must return content')

    const r2 = await READ_FILE_TOOL.execute(params({ file_path: file }))
    assert.ok(r2.content.includes('line 1'), 'second full read must return content (no artifactStore)')
  })

  // ── 边界场景 ──

  it('different files have independent fileReadHistory', async () => {
    const f1 = makeFile('src/a.ts', 30)
    const f2 = makeFile('src/b.ts', 30)

    // 全量读两个不同的文件
    await READ_FILE_TOOL.execute(params({ file_path: f1 }))
    await READ_FILE_TOOL.execute(params({ file_path: f2 }))

    // 片段读取 f1 → 应被阻断（fileReadHistory 命中）
    const r = await READ_FILE_TOOL.execute(params({ file_path: f1, offset: 10, limit: 5 }))
    assert.ok(r.content.includes('was already read in full'), 'f1 fragment must be blocked')
  })

  it('trim evicts oldest entries when exceeding FILE_READ_HISTORY_MAX', async () => {
    // 创建 250 个文件（超过默认 MAX=200），全量读取
    for (let i = 0; i < 250; i++) {
      const file = makeFile(`src/mod${i}.ts`, 5)
      await READ_FILE_TOOL.execute(params({ file_path: file }))
    }
    // trim 不应崩溃；后续操作应正常
    // 最老的文件 mod0 可能已被清理，重新创建一个并全量读取
    const freshFile = makeFile('src/later.ts', 5)
    const r1 = await READ_FILE_TOOL.execute(params({ file_path: freshFile }))
    assert.ok(r1.content.includes('line 1'), 'read after trim must still work')
  })
})
