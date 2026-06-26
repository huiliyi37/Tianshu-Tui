import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { HASH_EDIT_TOOL } from '../hash-edit.js'
import { markSessionFileEdit, wasFileEditedBySession, __resetSessionFileEditsForTests } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

// Use a directory inside the project tree so validatePath() doesn't reject
// file operations (security hardening requires all paths within cwd).
const TEST_BASE = join(process.cwd(), '.test-tmp')

let dir: string
function setup(files: Record<string, string>): string {
  dir = join(TEST_BASE, `hash-edit-${Date.now()}`)
  mkdirSync(dir, { recursive: true })
  for (const [name, content] of Object.entries(files)) {
    writeFileSync(join(dir, name), content, 'utf-8')
  }
  return dir
}

afterEach(() => {
  try { rmSync(dir, { recursive: true }) } catch { /* ok */ }
  __resetSessionFileEditsForTests()
})

function params(overrides: Partial<Record<string, unknown>> = {}): ToolCallParams {
  return {
    input: {
      file_path: join(dir, 'test.ts'),
      anchors: ['L1:abc123', 'L3:ghi789'],
      new_string: 'replacement line',
      ...overrides,
    },
    toolUseId: 'tu_1',
    cwd: dir,
  }
}

describe('hash_edit', () => {
  it('replaces lines between anchors', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\nline four\n',
    })
    const lines = readFileSync(join(cwd, 'test.ts'), 'utf-8').split('\n')
    // Compute hashes ourselves to construct valid anchors
    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: [`L1:${h(lines[0]!)}`, `L3:${h(lines[2]!)}`],
      new_string: 'replaced one\nreplaced two\nreplaced three',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('replaced L1-L3'))

    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'replaced one\nreplaced two\nreplaced three\nline four\n')
  })

  it('rejects stale anchors', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\n',
    })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L1:deadbeef', 'L3:cafebabe'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('stale'))
    assert.ok(result.content.includes('deadbeef'))
  })

  it('deletes lines when new_string is empty', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\nline four\n',
    })
    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const lines = readFileSync(join(cwd, 'test.ts'), 'utf-8').split('\n')
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: [`L2:${h(lines[1]!)}`, `L3:${h(lines[2]!)}`],
      new_string: '',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)

    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'line one\nline four\n')
  })

  it('rejects invalid anchor format', async () => {
    const cwd = setup({ 'test.ts': 'a\n' })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['not-an-anchor'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('invalid anchor format'))
  })

  it('rejects too many anchors', async () => {
    const cwd = setup({ 'test.ts': 'a\n' })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L1:aaaaaaaa', 'L2:bbbbbbbb', 'L3:cccccccc', 'L4:dddddddd'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('1-3'))
  })

  it('rejects non-existent file', async () => {
    const cwd = setup({})
    const p = params({ file_path: join(cwd, 'nonexistent.ts') })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('File not found'))
  })

  it('rejects path traversal', async () => {
    const cwd = setup({ 'test.ts': 'a\n' })
    const p = params({ file_path: '../outside.ts' })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('escapes'))
  })

  it('requires approval', () => {
    assert.equal(HASH_EDIT_TOOL.requiresApproval({} as any), true)
  })

  it('is not concurrency safe', () => {
    assert.equal(HASH_EDIT_TOOL.isConcurrencySafe(), false)
  })

  it('accepts position-only anchors (no hash)', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\nline four\n',
    })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L2', 'L3'],
      new_string: 'replaced two\nreplaced three',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('replaced L2-L3'))

    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'line one\nreplaced two\nreplaced three\nline four\n')
  })

  it('rejects position-only anchor when line exceeds file', async () => {
    const cwd = setup({ 'test.ts': 'a\nb\n' })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L99'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('stale') || result.content.includes('exceeds'))
  })

  it('mixes full-hash and position-only anchors', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\n',
    })
    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const lines = readFileSync(join(cwd, 'test.ts'), 'utf-8').split('\n')
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: [`L1:${h(lines[0]!)}`, 'L2'],
      new_string: 'new one\nnew two',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)

    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'new one\nnew two\nline three\n')
  })

  // ── P0: position-only hard reject after session file edit ──

  it('rejects position-only anchors after session file edit', async () => {
    const cwd = setup({ 'test.ts': 'line one\nline two\nline three\n' })
    const filePath = join(cwd, 'test.ts')
    markSessionFileEdit(filePath)
    assert.equal(wasFileEditedBySession(filePath), true)

    const p = params({
      file_path: filePath,
      anchors: ['L1', 'L2'],
      new_string: 'new one\nnew two',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('position-only anchors blocked'))
    const content = readFileSync(filePath, 'utf-8')
    assert.equal(content, 'line one\nline two\nline three\n')
  })

  it('full-hash anchors NOT blocked even after session file edit', async () => {
    const cwd = setup({ 'test.ts': 'line one\nline two\nline three\n' })
    const filePath = join(cwd, 'test.ts')
    markSessionFileEdit(filePath)

    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const lines = readFileSync(filePath, 'utf-8').split('\n')
    const p = params({
      file_path: filePath,
      anchors: [`L1:${h(lines[0]!)}`, `L2:${h(lines[1]!)}`],
      new_string: 'new one\nnew two',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)
    const newContent = readFileSync(filePath, 'utf-8')
    assert.equal(newContent, 'new one\nnew two\nline three\n')
  })

  it('position-only succeeds on a file NOT previously edited this session', async () => {
    const cwd = setup({ 'test.ts': 'a\nb\nc\n' })
    const filePath = join(cwd, 'test.ts')
    assert.equal(wasFileEditedBySession(filePath), false)

    const p = params({
      file_path: filePath,
      anchors: ['L1'],
      new_string: 'replaced a',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)
  })

  // ── stale recovery: anchors auto-recover when content shifted by prior edit ──
  // 连续 hash_edit 时第一次编辑后行号全局移位，后续锚点过期。
  // stale recovery 在锚点预期行号附近搜索匹配哈希的行，自动重算锚点。

  it('stale anchors auto-recover when content shifted by prior edit', async () => {
    const cwd = setup({
      'test.ts': 'a\nb\nc\nd\ne\n',
    })
    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const lines = readFileSync(join(cwd, 'test.ts'), 'utf-8').split('\n')
    // 模拟：行号因前序插入而偏移。原 L1=a L3=c → 现在 L3=a L5=c
    // 写入新内容：在 a 前插入两行
    const shifted = 'inserted1\ninserted2\na\nb\nc\nd\ne\n'
    writeFileSync(join(cwd, 'test.ts'), shifted, 'utf-8')

    // 用旧锚点 L1:<hash_a> L3:<hash_c> 应该自动搜索并恢复
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: [`L1:${h(lines[0]!)}`, `L3:${h(lines[2]!)}`],
      new_string: 'REPLACED',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('auto-recovered'), `expected auto-recovered in: ${result.content}`)

    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    // a → REPLACED，b 和 c 被替换掉，d e 保留
    assert.equal(newContent, 'inserted1\ninserted2\nREPLACED\nd\ne\n')
  })

  it('stale recovery fails when anchor content not in search window', async () => {
    const cwd = setup({
      'test.ts': 'line one\nline two\nline three\n',
    })
    // 故意给一个完全不在文件中的哈希
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L1:deadbeef', 'L2:cafebabe'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    // 搜索窗口内找不到 → 仍报 stale 错误（fail-safe）
    assert.ok(result.content.includes('stale'), `expected stale error, got: ${result.content}`)
    // 文件未被修改
    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'line one\nline two\nline three\n')
  })

  it('stale recovery on position-only anchors falls through to error', async () => {
    // position-only 锚点没有哈希 → 无法做内容搜索恢复。
    // 用 L99（超出文件长度）触发位置锚点的行号验证失败。
    const cwd = setup({ 'test.ts': 'a\nb\nc\n' })
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: ['L99'],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    // position-only 锚点 → 不进入 stale recovery（allFullHash=false），直接报错
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('stale') || result.content.includes('exceeds'),
      `expected stale/exceeds error, got: ${result.content}`)
  })

  it('stale recovery rejects when only some anchors recoverable', async () => {
    const cwd = setup({
      'test.ts': 'alpha\nbeta\ngamma\ndelta\n',
    })
    const { createHash } = await import('crypto')
    function h(line: string): string {
      return createHash('sha256').update(line).digest('hex').slice(0, 8)
    }
    const originalLines = readFileSync(join(cwd, 'test.ts'), 'utf-8').split('\n')

    // 修改文件：保留 alpha 但改了 beta 内容
    writeFileSync(join(cwd, 'test.ts'), 'alpha\nCHANGED\ngamma\ndelta\n', 'utf-8')

    // L1:alpha 能找到，L2:beta 哈希已变找不到
    const p = params({
      file_path: join(cwd, 'test.ts'),
      anchors: [`L1:${h(originalLines[0]!)}`, `L2:${h(originalLines[1]!)}`],
      new_string: 'x',
    })
    const result = await HASH_EDIT_TOOL.execute(p)
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('stale'), `expected stale error, got: ${result.content}`)
    // 文件未被修改（全部可恢复才应用编辑）
    const newContent = readFileSync(join(cwd, 'test.ts'), 'utf-8')
    assert.equal(newContent, 'alpha\nCHANGED\ngamma\ndelta\n')
  })
})
