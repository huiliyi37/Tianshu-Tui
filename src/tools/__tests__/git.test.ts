import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { GIT_TOOL } from '../git.js'

const TMP = join(import.meta.dirname, '.git-test-tmp')

describe('GIT_TOOL', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    execSync('git init', { cwd: TMP })
    execSync('git config user.email "test@test.com"', { cwd: TMP })
    execSync('git config user.name "Test"', { cwd: TMP })
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('has correct definition name', () => {
    assert.equal(GIT_TOOL.definition.name, 'git')
  })

  it('returns status for clean repo', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'status' },
      toolUseId: 'tu_1',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('clean'))
  })

  it('returns diff summary', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'a.txt'), 'modified')

    const result = await GIT_TOOL.execute({
      input: { action: 'diff_summary' },
      toolUseId: 'tu_2',
      cwd: TMP,
    })
    assert.ok(result.content.includes('a.txt'))
  })

  it('commits changes with message', async () => {
    writeFileSync(join(TMP, 'a.txt'), 'hello')
    execSync('git add .', { cwd: TMP })
    execSync('git commit -m "init"', { cwd: TMP })
    writeFileSync(join(TMP, 'b.txt'), 'new file')
    execSync('git add .', { cwd: TMP })

    const result = await GIT_TOOL.execute({
      input: { action: 'commit', message: 'Add b.txt' },
      toolUseId: 'tu_3',
      cwd: TMP,
    })
    assert.equal(result.isError, undefined)
    assert.ok(result.content.includes('Add b.txt'))
  })

  it('rejects unknown action', async () => {
    const result = await GIT_TOOL.execute({
      input: { action: 'push' },
      toolUseId: 'tu_4',
      cwd: TMP,
    })
    assert.equal(result.isError, true)
    assert.ok(result.content.includes('Unknown action'))
  })

  it('requires approval for commit action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'commit' }, toolUseId: 't', cwd: '/' }), true)
  })

  it('does not require approval for status action', () => {
    assert.equal(GIT_TOOL.requiresApproval({ input: { action: 'status' }, toolUseId: 't', cwd: '/' }), false)
  })
})
