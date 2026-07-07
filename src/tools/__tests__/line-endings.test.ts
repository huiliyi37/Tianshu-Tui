import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'
import { __setFileReadMtimeForTests } from '../read-file.js'

import {
  detectEol,
  toLf,
  applyEol,
  requiredEol,
  chooseEol,
  normalizeForWrite,
  detectFileEol,
} from '../line-endings.js'
import { WRITE_FILE_TOOL } from '../write-file.js'
import { EDIT_FILE_TOOL } from '../edit.js'
import { HASH_EDIT_TOOL, hashLine } from '../hash-edit.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'opencode-line-endings-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

/** True when every LF in `s` is preceded by CR (pure CRLF, no stray bare LF). */
function isPureCrlf(s: string): boolean {
  for (let i = 0; i < s.length; i++) {
    if (s.charCodeAt(i) === 10 && (i === 0 || s.charCodeAt(i - 1) !== 13)) return false
  }
  return s.includes('\r\n')
}

describe('line-endings pure helpers', () => {
  it('detectEol returns dominant style', () => {
    assert.equal(detectEol('a\r\nb\r\n'), 'crlf')
    assert.equal(detectEol('a\nb\n'), 'lf')
    assert.equal(detectEol('no newline'), null)
    // Mixed: more CRLF than LF → crlf
    assert.equal(detectEol('a\r\nb\r\nc\n'), 'crlf')
    assert.equal(detectEol('a\nb\nc\r\n'), 'lf')
  })

  it('toLf collapses CRLF and bare CR', () => {
    assert.equal(toLf('a\r\nb\rc\nd'), 'a\nb\nc\nd')
  })

  it('applyEol round-trips', () => {
    assert.equal(applyEol('a\nb\n', 'crlf'), 'a\r\nb\r\n')
    assert.equal(applyEol('a\r\nb\r\n', 'lf'), 'a\nb\n')
    // applyEol(x,'lf') === toLf(x)
    assert.equal(applyEol('x\r\ny', 'lf'), toLf('x\r\ny'))
  })

  it('requiredEol mandates CRLF for batch files only', () => {
    assert.equal(requiredEol('/x/run.bat'), 'crlf')
    assert.equal(requiredEol('/x/run.CMD'), 'crlf')
    assert.equal(requiredEol('/x/app.ts'), null)
    assert.equal(requiredEol('/x/script.sh'), null)
  })

  it('chooseEol priority: requirement > existing > lf default', () => {
    // .bat forces crlf even if existing file is LF
    assert.equal(chooseEol('/x/a.bat', 'lf'), 'crlf')
    // non-required preserves existing
    assert.equal(chooseEol('/x/a.ts', 'crlf'), 'crlf')
    assert.equal(chooseEol('/x/a.ts', 'lf'), 'lf')
    // new file default
    assert.equal(chooseEol('/x/a.ts', null), 'lf')
  })

  it('normalizeForWrite applies the resolved policy', () => {
    assert.equal(normalizeForWrite('/x/a.bat', 'echo\npause\n'), 'echo\r\npause\r\n')
    assert.equal(normalizeForWrite('/x/a.ts', 'const x=1\n'), 'const x=1\n')
    assert.equal(normalizeForWrite('/x/a.txt', 'new\n', 'old\r\nfile\r\n'), 'new\r\n')
    assert.equal(normalizeForWrite('/x/a.txt', 'new\n', 'old\nfile\n'), 'new\n')
  })
})

describe('detectFileEol (bounded read)', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('detects CRLF / LF / none / missing', async () => {
    const crlf = join(TEST_DIR, 'crlf.txt')
    const lf = join(TEST_DIR, 'lf.txt')
    const none = join(TEST_DIR, 'none.txt')
    writeFileSync(crlf, 'a\r\nb\r\n')
    writeFileSync(lf, 'a\nb\n')
    writeFileSync(none, 'single line')
    assert.equal(await detectFileEol(crlf), 'crlf')
    assert.equal(await detectFileEol(lf), 'lf')
    assert.equal(await detectFileEol(none), null)
    assert.equal(await detectFileEol(join(TEST_DIR, 'missing.txt')), null)
  })
})

describe('write_file EOL policy', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('forces CRLF for a new .bat file', async () => {
    const file = join(TEST_DIR, 'run.bat')
    const res = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: '@echo off\necho hello\npause\n',
    }))
    assert.ok(!res.isError)
    const onDisk = readFileSync(file, 'utf-8')
    assert.equal(onDisk, '@echo off\r\necho hello\r\npause\r\n')
    assert.ok(isPureCrlf(onDisk))
  })

  it('keeps LF for a new source file', async () => {
    const file = join(TEST_DIR, 'mod.ts')
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'const x = 1\nexport {}\n' }))
    assert.equal(readFileSync(file, 'utf-8'), 'const x = 1\nexport {}\n')
  })

  it('preserves a CRLF file on overwrite', async () => {
    const file = join(TEST_DIR, 'config.txt')
    writeFileSync(file, 'old\r\nstuff\r\n')
    __setFileReadMtimeForTests(file, statSync(file).mtimeMs)
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'new\nstuff\nhere\n' }))
    const onDisk = readFileSync(file, 'utf-8')
    assert.equal(onDisk, 'new\r\nstuff\r\nhere\r\n')
    assert.ok(isPureCrlf(onDisk))
  })

  it('preserves an LF file on overwrite', async () => {
    const file = join(TEST_DIR, 'config2.txt')
    writeFileSync(file, 'old\nstuff\n')
    __setFileReadMtimeForTests(file, statSync(file).mtimeMs)
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'new\nstuff\n' }))
    assert.equal(readFileSync(file, 'utf-8'), 'new\nstuff\n')
  })
})

describe('edit_file preserves CRLF', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('matches a multi-line LF old_string against a CRLF file and keeps CRLF', async () => {
    const file = join(TEST_DIR, 'crlf.txt')
    writeFileSync(file, 'alpha\r\nbeta\r\ngamma\r\n')
    const res = await EDIT_FILE_TOOL.execute(makeParams({
      file_path: file,
      old_string: 'beta\ngamma',
      new_string: 'BETA\nGAMMA',
    }))
    assert.ok(!res.isError, res.content)
    // Exact (non-fuzzy) match: no whitespace-drift warning should appear.
    assert.ok(!res.content.includes('[fuzzy]'), res.content)
    const onDisk = readFileSync(file, 'utf-8')
    assert.equal(onDisk, 'alpha\r\nBETA\r\nGAMMA\r\n')
    assert.ok(isPureCrlf(onDisk))
  })

  it('keeps LF files on LF (byte-identical behavior)', async () => {
    const file = join(TEST_DIR, 'lf.txt')
    writeFileSync(file, 'one\ntwo\nthree\n')
    await EDIT_FILE_TOOL.execute(makeParams({ file_path: file, old_string: 'two', new_string: 'TWO' }))
    assert.equal(readFileSync(file, 'utf-8'), 'one\nTWO\nthree\n')
  })
})

describe('hash_edit preserves CRLF', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })

  it('rebuilds a CRLF file without mixing line endings', async () => {
    const file = join(TEST_DIR, 'crlf.txt')
    writeFileSync(file, 'a\r\nb\r\nc\r\n')
    // Replace the L1-L3 range (a..c) with two new LF lines.
    const res = await HASH_EDIT_TOOL.execute(makeParams({
      file_path: file,
      anchors: [`L1:${hashLine('a')}`, `L3:${hashLine('c')}`],
      new_string: 'X\nY',
    }))
    assert.ok(!res.isError, res.content)
    const onDisk = readFileSync(file, 'utf-8')
    assert.equal(onDisk, 'X\r\nY\r\n')
    assert.ok(isPureCrlf(onDisk))
  })
})
