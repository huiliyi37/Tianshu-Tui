import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync, readFileSync, statSync } from 'fs'
import { join } from 'path'

import { setTargetConventions, getTargetPlatform, getTargetEol } from '../platform.js'
import { chooseEol } from '../tools/line-endings.js'
import { WRITE_FILE_TOOL } from '../tools/write-file.js'
import { __setFileReadMtimeForTests } from '../tools/read-file.js'
import type { ToolCallParams } from '../tools/types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'platform-conventions-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
}

describe('setTargetConventions / getTargetPlatform / getTargetEol', () => {
  // Always restore the host default so this file doesn't contaminate sibling tests.
  afterEach(() => setTargetConventions('auto', 'auto'))

  it('maps explicit platforms', () => {
    setTargetConventions('windows', 'auto')
    assert.equal(getTargetPlatform(), 'win32')
    assert.equal(getTargetEol(), 'crlf')

    setTargetConventions('macos', 'auto')
    assert.equal(getTargetPlatform(), 'darwin')
    assert.equal(getTargetEol(), 'lf')

    setTargetConventions('linux', 'auto')
    assert.equal(getTargetPlatform(), 'linux')
    assert.equal(getTargetEol(), 'lf')
  })

  it('auto follows the real host', () => {
    setTargetConventions('auto', 'auto')
    assert.equal(getTargetPlatform(), process.platform)
    assert.equal(getTargetEol(), process.platform === 'win32' ? 'crlf' : 'lf')
  })

  it('explicit eol overrides the platform-derived default', () => {
    // Windows target but force LF files.
    setTargetConventions('windows', 'lf')
    assert.equal(getTargetPlatform(), 'win32')
    assert.equal(getTargetEol(), 'lf')

    // Unix target but force CRLF files.
    setTargetConventions('macos', 'crlf')
    assert.equal(getTargetEol(), 'crlf')
  })
})

describe('chooseEol defaultEol parameter', () => {
  it('uses defaultEol only for new files (no requirement, no existing)', () => {
    assert.equal(chooseEol('/x/a.ts', null, 'crlf'), 'crlf')
    assert.equal(chooseEol('/x/a.ts', null, 'lf'), 'lf')
    assert.equal(chooseEol('/x/a.ts', null), 'lf') // default param stays LF
  })

  it('existing EOL and .bat requirement still win over defaultEol', () => {
    // Existing LF file keeps LF even when target default is CRLF.
    assert.equal(chooseEol('/x/a.ts', 'lf', 'crlf'), 'lf')
    // .bat is always CRLF even when target default is LF.
    assert.equal(chooseEol('/x/run.bat', 'lf', 'lf'), 'crlf')
  })
})

describe('write_file honors the target platform default', () => {
  beforeEach(() => {
    if (existsSync(TEST_DIR)) rmSync(TEST_DIR, { recursive: true })
    mkdirSync(TEST_DIR, { recursive: true })
  })
  afterEach(() => setTargetConventions('auto', 'auto'))

  it('new file gets CRLF when target=windows', async () => {
    setTargetConventions('windows', 'auto')
    const file = join(TEST_DIR, 'mod.ts')
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'const x = 1\nexport {}\n' }))
    assert.equal(readFileSync(file, 'utf-8'), 'const x = 1\r\nexport {}\r\n')
  })

  it('new file gets LF when target=macos', async () => {
    setTargetConventions('macos', 'auto')
    const file = join(TEST_DIR, 'mod.ts')
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'const x = 1\nexport {}\n' }))
    assert.equal(readFileSync(file, 'utf-8'), 'const x = 1\nexport {}\n')
  })

  it('existing file EOL still preserved regardless of target', async () => {
    setTargetConventions('windows', 'auto')
    const file = join(TEST_DIR, 'keep.txt')
    writeFileSync(file, 'old\nlf\nfile\n') // existing LF
    __setFileReadMtimeForTests(file, statSync(file).mtimeMs)
    await WRITE_FILE_TOOL.execute(makeParams({ file_path: file, content: 'new\nlf\ncontent\n' }))
    assert.equal(readFileSync(file, 'utf-8'), 'new\nlf\ncontent\n')
  })
})
