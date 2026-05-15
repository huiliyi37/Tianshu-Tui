import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execSync } from 'child_process'
import { DIFF_TOOL } from '../diff.js'
import type { ToolCallParams } from '../types.js'

let testDir: string

function makeParams(input: Record<string, unknown>): ToolCallParams {
  return { input, toolUseId: 'test-id', cwd: testDir }
}

function git(cmd: string): void {
  execSync(`git ${cmd}`, { cwd: testDir, stdio: 'pipe' })
}

describe('diff tool', () => {
  beforeEach(() => {
    testDir = mkdtempSync(join(tmpdir(), 'opencode-diff-test-'))
    git('init')
    git('config user.email "test@test.com"')
    git('config user.name "Test"')
    writeFileSync(join(testDir, 'initial.txt'), 'initial')
    git('add initial.txt')
    git('commit -m "initial"')
  })

  afterEach(() => {
    rmSync(testDir, { recursive: true, force: true })
  })

  it('returns "No changes" in a clean repo', async () => {
    const result = await DIFF_TOOL.execute(makeParams({}))
    assert.equal(result.isError, undefined)
    assert.equal(result.content, 'No changes.')
  })

  it('shows diff for modified file', async () => {
    writeFileSync(join(testDir, 'hello.txt'), 'original content')
    git('add hello.txt')
    git('commit -m "add hello"')

    writeFileSync(join(testDir, 'hello.txt'), 'modified content')
    const result = await DIFF_TOOL.execute(makeParams({}))
    assert.ok(!result.isError)
    assert.ok(result.content.includes('-original content'))
    assert.ok(result.content.includes('+modified content'))
  })

  it('shows staged diff when staged=true', async () => {
    writeFileSync(join(testDir, 'staged.txt'), 'staged content')
    git('add staged.txt')

    const result = await DIFF_TOOL.execute(makeParams({ staged: true }))
    assert.ok(!result.isError)
    assert.ok(result.content.includes('+staged content'))
  })

  it('filters by path', async () => {
    mkdirSync(join(testDir, 'src'))
    writeFileSync(join(testDir, 'src', 'a.ts'), 'aaa')
    writeFileSync(join(testDir, 'src', 'b.ts'), 'bbb')
    git('add src/')
    git('commit -m "add src"')

    writeFileSync(join(testDir, 'src', 'a.ts'), 'aaa-modified')
    writeFileSync(join(testDir, 'src', 'b.ts'), 'bbb-modified')

    const result = await DIFF_TOOL.execute(makeParams({ path: 'src/a.ts' }))
    assert.ok(!result.isError)
    assert.ok(result.content.includes('a.ts'))
    assert.ok(result.content.includes('+aaa-modified'))
    assert.ok(!result.content.includes('bbb-modified'))
  })

  it('rejects path traversal outside cwd', async () => {
    const result = await DIFF_TOOL.execute(makeParams({ path: '../outside.ts' }))
    assert.equal(result.isError, true)
    assert.match(result.content, /outside project directory/i)
  })

  it('requires no approval', () => {
    assert.equal(DIFF_TOOL.requiresApproval(makeParams({})), false)
  })

  it('is concurrency safe', () => {
    assert.equal(DIFF_TOOL.isConcurrencySafe(), true)
  })
})
