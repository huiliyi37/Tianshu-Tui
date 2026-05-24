import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { EDIT_FILE_TOOL } from '../edit.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(tmpdir(), 'opencode-edit-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('edit_file tool', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('replaces a unique string', async () => {
    const file = join(TEST_DIR, 'test.txt')
    writeFileSync(file, 'hello world')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'world',
      new_string: 'universe',
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.includes('Applied edit'))
  })

  it('rejects non-unique old_string', async () => {
    const file = join(TEST_DIR, 'dup.txt')
    writeFileSync(file, 'abc abc')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'abc',
      new_string: 'xyz',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('multiple locations'))
  })

  it('replaces all with replace_all flag', async () => {
    const file = join(TEST_DIR, 'all.txt')
    writeFileSync(file, 'aaa bbb aaa')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'aaa',
      new_string: 'ccc',
      replace_all: true,
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.includes('2 occurrences'))
  })

  it('rejects missing old_string', async () => {
    const file = join(TEST_DIR, 'miss.txt')
    writeFileSync(file, 'hello')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'not found',
      new_string: 'replacement',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('not found'))
  })

  it('rejects non-existent file', async () => {
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: join(TEST_DIR, 'nope.txt'),
      old_string: 'x',
      new_string: 'y',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('not found'))
  })

  it('rejects path traversal', async () => {
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: '../../etc/passwd',
      old_string: 'x',
      new_string: 'y',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Path escapes'))
  })

  it('requires approval', () => {
    assert.equal(EDIT_FILE_TOOL.requiresApproval(makeParams({})), true)
  })

  it('shows closest match when old_string differs by whitespace', async () => {
    const file = join(TEST_DIR, 'whitespace.txt')
    // File uses tabs, model passed spaces
    writeFileSync(file, 'function foo() {\n\treturn 1\n}\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'function foo() {\n    return 1\n}',
      new_string: 'function foo() {\n\treturn 2\n}',
    }))
    assert.equal(result.isError, true)
    // Should expose the actual file content as a diff so model can fix whitespace
    assert.ok(result.content.includes('Closest match'), `Expected diff hint, got: ${result.content}`)
    assert.ok(result.content.includes('expected'), 'should label expected vs actual')
    assert.ok(result.content.includes('actual'), 'should show actual file lines')
  })

  it('shows line numbers for multiple matches', async () => {
    const file = join(TEST_DIR, 'multi.txt')
    writeFileSync(file, 'line 1\nfoo\nline 3\nfoo\nline 5\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'foo',
      new_string: 'bar',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('multiple locations'))
    assert.ok(result.content.includes('Match 1 at line 2'), `Expected line 2 match, got: ${result.content}`)
    assert.ok(result.content.includes('Match 2 at line 4'), `Expected line 4 match, got: ${result.content}`)
  })

  it('reports clear error when old_string is completely absent', async () => {
    const file = join(TEST_DIR, 'absent.txt')
    writeFileSync(file, 'completely different content here\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'totallyUnrelatedSymbol123',
      new_string: 'replacement',
    }))
    assert.equal(result.isError, true)
    // Should not pretend to find a "closest match" when nothing is close.
    assert.ok(result.content.includes('not found'))
  })
})
