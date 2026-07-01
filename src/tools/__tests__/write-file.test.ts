import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'fs'
import { join } from 'path'
import { WRITE_FILE_TOOL } from '../write-file.js'
import type { ToolCallParams } from '../types.js'

const TEST_DIR = join(process.cwd(), '.test-tmp', 'opencode-write-test')

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: TEST_DIR }
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
    const result = await WRITE_FILE_TOOL.execute(makeParams({
      file_path: file,
      content: 'keep\nnew line\ntail\n',
    }))
    assert.ok(!result.isError)
    assert.ok(result.uiContent && /^@@/m.test(result.uiContent), 'uiContent has diff')
    assert.ok(/^-old line$/m.test(result.uiContent!), 'removal line')
    assert.ok(/^\+new line$/m.test(result.uiContent!), 'addition line')
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
})
