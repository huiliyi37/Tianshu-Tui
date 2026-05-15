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
})
