import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { HASH_EDIT_TOOL } from '../hash-edit.js'
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
})
