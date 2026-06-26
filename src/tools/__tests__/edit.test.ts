import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs'

import { join } from 'path'
import { EDIT_FILE_TOOL } from '../edit.js'
import type { ToolCallParams } from '../types.js'

// Use a directory inside the project tree so validatePath() doesn't reject
// file operations (security hardening requires all paths within cwd).
const TEST_DIR = join(process.cwd(), '.test-tmp', 'opencode-edit-test')

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

  it('applies the edit when old_string differs only by whitespace (fuzzy fallback)', async () => {
    const file = join(TEST_DIR, 'whitespace.txt')
    // File uses tabs, model passed spaces — C3 whitespace-tolerant matching
    // should land the edit instead of bouncing back a diagnostic error.
    writeFileSync(file, 'function foo() {\n\treturn 1\n}\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'function foo() {\n    return 1\n}',
      new_string: 'function foo() {\n\treturn 2\n}',
    }))
    assert.ok(!result.isError, `Expected fuzzy success, got: ${result.content}`)
    assert.match(result.content, /whitespace-tolerant/i)
    const content = readFileSync(file, 'utf-8')
    assert.ok(content.includes('return 2'), `edit should have landed, got: ${content}`)
  })

  it('[fuzzy visibility] includes [fuzzy] diff block when whitespace-tolerant match fires', async () => {
    const file = join(TEST_DIR, 'fuzzy-diff.txt')
    // File uses tabs; model's old_string uses 4 spaces — fuzzy fires.
    writeFileSync(file, 'line one\n\tindented line\nline three\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'line one\n    indented line\nline three',
      new_string: 'line one\n    REPLACED\nline three',
    }))
    assert.ok(!result.isError, `Expected fuzzy success, got: ${result.content}`)
    // The content MUST contain the [fuzzy] diff visibility markers.
    assert.ok(result.content.includes('[fuzzy]'), `content should contain [fuzzy] marker, got: ${result.content}`)
    assert.ok(result.content.includes('[fuzzy] diff:'), `content should contain [fuzzy] diff:, got: ${result.content}`)
    // The diff should surface the raw whitespace difference (tab vs spaces).
    // JSON.stringify makes tabs visible as \t in the diff output.
    assert.match(result.content, /exp.*\\t|act.*\\t|exp.*    |act.*    /,
      `diff should show the tab/space difference, got: ${result.content}`)
  })

  it('[fuzzy visibility] precise match does NOT contain [fuzzy] markers', async () => {
    const file = join(TEST_DIR, 'precise.txt')
    writeFileSync(file, 'hello world\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'hello world',
      new_string: 'goodbye world',
    }))
    assert.ok(!result.isError)
    // Precise match path must not emit [fuzzy] markers.
    assert.ok(!result.content.includes('[fuzzy]'), `precise match should not have [fuzzy], got: ${result.content}`)
  })

  it('still reports a not-found error when the block is genuinely absent (no false fuzzy match)', async () => {
    const file = join(TEST_DIR, 'no-fuzzy.txt')
    writeFileSync(file, 'function foo() {\n\treturn 1\n}\n')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'function bar() {\n  return 42\n}',
      new_string: 'x',
    }))
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('not found') || result.content.includes('Closest match'))
  })

  it('edits a large file above the old 100KB cap', async () => {
    const file = join(TEST_DIR, 'big.txt')
    // ~300KB of filler — comfortably over the retired 100KB limit, under 8MB.
    const filler = 'x'.repeat(300 * 1024)
    writeFileSync(file, `${filler}\nUNIQUE_ANCHOR\n${filler}`)
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'UNIQUE_ANCHOR',
      new_string: 'REPLACED_ANCHOR',
    }))
    assert.ok(!result.isError, `Expected large-file edit to succeed, got: ${result.content.slice(0, 200)}`)
    const content = readFileSync(file, 'utf-8')
    assert.ok(content.includes('REPLACED_ANCHOR'))
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

  it('warns when replace_all count mismatches expected_count', async () => {
    const filePath = join(TEST_DIR, 'mismatch.ts')
    // "foo" appears once (lowercase). "Foo" (capitalized) does not match.
    writeFileSync(filePath, 'foo\nFoo\n', 'utf-8')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
      expected_count: 2,
    }))
    assert.ok(!result.isError, 'should not be an error — file was modified')
    assert.ok(result.content.includes('Warning'), `expected Warning, got: ${result.content}`)
    assert.ok(result.content.includes('expected 2'), `expected mention of expected count, got: ${result.content}`)
    assert.ok(result.content.includes('replaced 1'), `expected mention of actual count, got: ${result.content}`)
  })

  it('no warning when replace_all count matches expected_count', async () => {
    const filePath = join(TEST_DIR, 'match.ts')
    writeFileSync(filePath, 'foo\nfoo\nfoo\n', 'utf-8')
    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'bar',
      replace_all: true,
      expected_count: 3,
    }))
    assert.ok(!result.isError)
    assert.ok(!result.content.includes('Warning'), `unexpected Warning: ${result.content}`)
    assert.ok(result.content.includes('Replaced all 3'), `expected success, got: ${result.content}`)
  })

  it('on stale file: auto-reapplies edit when old_string still matches', async () => {
    const filePath = join(TEST_DIR, 'stale-match.ts')
    writeFileSync(filePath, 'const x = 1\nconst y = 2\n')

    const { __setFileReadMtimeForTests } = await import('../read-file.js')
    const oldMtime = statSync(filePath).mtimeMs
    __setFileReadMtimeForTests(filePath, oldMtime)

    writeFileSync(filePath, 'const x = 1\nconst y = 2\n// added comment\n')

    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: 'const y = 2',
      new_string: 'const y = 3',
    }))

    assert.ok(!result.isError, `Expected success on stale auto-apply, got: ${result.content}`)
    assert.match(result.content, /modified externally.*still matched/i)

    const content = readFileSync(filePath, 'utf-8')
    assert.ok(content.includes('const y = 3'))
    assert.ok(content.includes('// added comment'))
  })

  it('on stale file: replace_all warns when expected_count mismatches', async () => {
    const filePath = join(TEST_DIR, 'stale-count.ts')
    writeFileSync(filePath, 'foo\nfoo\nfoo\nbar\n')

    const { __setFileReadMtimeForTests } = await import('../read-file.js')
    const oldMtime = statSync(filePath).mtimeMs
    __setFileReadMtimeForTests(filePath, oldMtime)

    writeFileSync(filePath, 'foo\nfoo\nbaz\nbar\n// added\n')
    // Now only 2 'foo' occurrences instead of 3

    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
      expected_count: 3,
    }))

    assert.ok(!result.isError, `Expected success on stale auto-apply, got: ${result.content}`)
    assert.match(result.content, /Warning.*expected 3.*replaced 2/i,
      `Expected expected_count warning, got: ${result.content}`)
  })

  it('on stale file: replace_all no warning when expected_count matches', async () => {
    const filePath = join(TEST_DIR, 'stale-count-ok.ts')
    writeFileSync(filePath, 'foo\nfoo\nbar\n')

    const { __setFileReadMtimeForTests } = await import('../read-file.js')
    const oldMtime = statSync(filePath).mtimeMs
    __setFileReadMtimeForTests(filePath, oldMtime)

    writeFileSync(filePath, 'foo\nfoo\nbar\n// added\n')
    // Still 2 'foo' occurrences

    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: 'foo',
      new_string: 'qux',
      replace_all: true,
      expected_count: 2,
    }))

    assert.ok(!result.isError, `Expected success on stale auto-apply, got: ${result.content}`)
    assert.ok(!result.content.includes('Warning'),
      `Expected no warning, got: ${result.content}`)
  })

  it('on stale file: shows current content near old_string when it no longer matches', async () => {
    const filePath = join(TEST_DIR, 'stale-nomatch.ts')
    writeFileSync(filePath, 'function foo() {\n  return 1\n}\n')

    const { __setFileReadMtimeForTests } = await import('../read-file.js')
    const oldMtime = statSync(filePath).mtimeMs
    __setFileReadMtimeForTests(filePath, oldMtime)

    writeFileSync(filePath, 'function foo() {\n  return 99\n}\n')

    const result = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: filePath,
      old_string: '  return 1',
      new_string: '  return 2',
    }))

    assert.equal(result.isError, true)
    assert.match(result.content, /return 99/, `Should show actual file content, got: ${result.content}`)
  })
})

