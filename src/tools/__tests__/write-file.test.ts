import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, statSync, readFileSync } from 'fs'
import { join } from 'path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { __setFileReadMtimeForTests } from '../read-file.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'opencode-write-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

/** Register the file as observed this session so the blind-overwrite guard lets
 *  the write through. Key must match validatePath output — the resolve(cwd, path)
 *  form, NOT realpathSync (diverges under symlinked tmp dirs, e.g. macOS /var). */
function markObserved(file: string): void {
  __setFileReadMtimeForTests(file, statSync(file).mtimeMs)
}

describe('write_file tool — uiContent diff', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('new file → uiContent is an all-additions diff', async () => {
    const file = join(TEST_DIR, 'fresh.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'one\ntwo\nthree\n',
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.startsWith('Wrote '))
    assert.ok(!result.content.includes('@@'), 'diff must not leak into model content')
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has hunk header')
    assert.ok(/^\+one$/m.test(result.uiContent!))
    const removals = result.uiContent!.split('\n').filter(l => l.startsWith('-') && !l.startsWith('---'))
    assert.equal(removals.length, 0, 'no removal content lines for a new file')
  })

  it('overwrite → uiContent shows removals and additions', async () => {
    const file = join(TEST_DIR, 'over.txt')
    writeFileSync(file, 'keep\nold line\ntail\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'keep\nnew line\ntail\n',
    }))
    assert.ok(!result.isError)
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has diff')
    assert.ok(/^-old line$/m.test(result.uiContent!), 'removal line')
    assert.ok(/^\+new line$/m.test(result.uiContent!), 'addition line')
  })

  it('overwrite → changedRanges localizes the changed line (for LSP narrowing)', async () => {
    const file = join(TEST_DIR, 'ranges.txt')
    writeFileSync(file, 'keep\nold line\ntail\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'keep\nnew line\ntail\n',
    }))
    assert.ok(!result.isError)
    assert.ok(Array.isArray(result.changedRanges) && result.changedRanges.length === 1, 'one changed range')
    assert.deepEqual(result.changedRanges![0], { start: 2, end: 2 }, 'line 2 changed')
  })

  it('new file → changedRanges covers the whole file', async () => {
    const file = join(TEST_DIR, 'brand-new.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'a\nb\nc\n',
    }))
    assert.ok(!result.isError)
    assert.ok(Array.isArray(result.changedRanges) && result.changedRanges.length === 1)
    assert.equal(result.changedRanges![0]!.start, 1)
    assert.ok(result.changedRanges![0]!.end >= 3)
  })

  it('rewriting identical content yields no diff (uiContent undefined)', async () => {
    const file = join(TEST_DIR, 'same.txt')
    writeFileSync(file, 'unchanged\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'unchanged\n',
    }))
    assert.ok(!result.isError)
    assert.equal(result.uiContent, undefined)
  })

  it('rejects pointer-placeholder content regurgitated from history', async () => {
    const file = join(TEST_DIR, 'regurgitated.ts')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: `[file written to ${file} — 202 lines, 6462 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError, 'pointer placeholder must be rejected')
    assert.ok(result.content.includes('pointer placeholder'), 'error explains what went wrong')
    assert.ok(!existsSync(file), 'no file must be created from placeholder content')
  })

  it('rejects pointer-placeholder content with leading whitespace', async () => {
    const file = join(TEST_DIR, 'regurgitated2.ts')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: `\n  [file written to ${file} — 10 lines, 100 chars. Use read_file to review.]`,
    }))
    assert.ok(result.isError)
    assert.ok(!existsSync(file))
  })

  it('allows real content that merely mentions the pointer prefix mid-text', async () => {
    const file = join(TEST_DIR, 'mentions-pointer.md')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'Docs: the history shows "[file written to ..." pointers for large writes.\n',
    }))
    assert.ok(!result.isError, 'mid-text mention must not be rejected')
    assert.ok(existsSync(file))
  })

  it('overwriting an oversized existing file skips the diff base (no misleading diff)', async () => {
    const file = join(TEST_DIR, 'huge.txt')
    // 11 MB — above MAX_WRITE_FILE_BYTES, so the old content is intentionally
    // not read and the card should fall back to the summary text.
    writeFileSync(file, 'x'.repeat(11 * 1024 * 1024))
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'small replacement',
    }))
    assert.ok(!result.isError)
    assert.ok(result.content.startsWith('Wrote '))
    assert.equal(result.uiContent, undefined, 'uiContent should be undefined when old content is not loaded')
    assert.deepEqual(result.changedRanges, [], 'changedRanges should be empty when old content is unknown')
  })
})

describe('write_file tool — blind-overwrite guard', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('refuses to overwrite an existing file never observed this session', async () => {
    const file = join(TEST_DIR, 'precious.test.ts')
    writeFileSync(file, 'original 221-line test suite\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'blind replacement\n',
    }))
    assert.ok(result.isError, 'blind overwrite must be refused')
    assert.ok(result.content.includes('never read in this session'), 'error explains the guard')
    assert.equal(readFileSync(file, 'utf-8'), 'original 221-line test suite\n', 'file untouched')
  })

  it('allows overwrite once the file has been observed', async () => {
    const file = join(TEST_DIR, 'observed.txt')
    writeFileSync(file, 'old\n')
    markObserved(file)
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'new\n',
    }))
    assert.ok(!result.isError)
    assert.equal(readFileSync(file, 'utf-8'), 'new\n')
  })

  it('byte-identical rewrite of an unobserved file is exempt (no information loss)', async () => {
    const file = join(TEST_DIR, 'identical.txt')
    writeFileSync(file, 'same content\n')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'same content\n',
    }))
    assert.ok(!result.isError, 'identical content cannot destroy anything')
  })

  it('new files are never guarded', async () => {
    const file = join(TEST_DIR, 'brand-new-guarded.txt')
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'hello\n',
    }))
    assert.ok(!result.isError)
  })

  it('RIVET_WRITE_OVERWRITE_GUARD=0 disables the guard', async () => {
    const file = join(TEST_DIR, 'unguarded.txt')
    writeFileSync(file, 'old\n')
    process.env.RIVET_WRITE_OVERWRITE_GUARD = '0'
    try {
      const result = await WRITE_FILE_TOOL.execute(makeParams({
        file_path: file,
        content: 'new\n',
      }))
      assert.ok(!result.isError)
    } finally {
      delete process.env.RIVET_WRITE_OVERWRITE_GUARD
    }
  })
})
