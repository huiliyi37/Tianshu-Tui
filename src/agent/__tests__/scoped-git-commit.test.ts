import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { commitScopedFiles } from '../scoped-git-commit.js'

const TMP = join(import.meta.dirname, '.scoped-commit-tmp')

function git(args: string[]): string {
  const result = spawnSync('git', args, { cwd: TMP, encoding: 'utf-8' })
  if (result.status !== 0) throw new Error(result.stderr || `git ${args.join(' ')} failed`)
  return result.stdout
}

describe('commitScopedFiles', () => {
  beforeEach(() => {
    rmSync(TMP, { recursive: true, force: true })
    mkdirSync(TMP, { recursive: true })
    git(['init'])
    git(['config', 'user.email', 'test@test.com'])
    git(['config', 'user.name', 'Test'])
    writeFileSync(join(TMP, 'owned.txt'), 'base owned')
    writeFileSync(join(TMP, 'other.txt'), 'base other')
    git(['add', '.'])
    git(['commit', '-m', 'init'])
  })

  afterEach(() => {
    rmSync(TMP, { recursive: true, force: true })
  })

  it('commits only scoped files and leaves external dirty files untouched', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    writeFileSync(join(TMP, 'other.txt'), 'external change')
    writeFileSync(join(TMP, 'other-new.txt'), 'external untracked')

    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: scoped commit' })

    assert.equal(result.ok, true)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['owned.txt'])
    const status = git(['status', '--porcelain'])
    assert.match(status, / M other\.txt/)
    assert.match(status, /\?\? other-new\.txt/)
  })

  it('commits scoped untracked files without staging unrelated untracked files', () => {
    writeFileSync(join(TMP, 'new-owned.txt'), 'owned new')
    writeFileSync(join(TMP, 'other-new.txt'), 'external untracked')

    const result = commitScopedFiles({ cwd: TMP, files: ['new-owned.txt'], message: 'fix: scoped new file' })

    assert.equal(result.ok, true)
    const committedFiles = git(['show', '--name-only', '--pretty=format:', 'HEAD']).split('\n').filter(Boolean)
    assert.deepEqual(committedFiles, ['new-owned.txt'])
    const status = git(['status', '--porcelain'])
    assert.match(status, /\?\? other-new\.txt/)
  })

  it('rejects an empty file list without creating a commit', () => {
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: [], message: 'fix: empty' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No owned files/)
    assert.equal(after, before)
  })

  it('rejects paths outside cwd without creating a commit', () => {
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['../outside.txt'], message: 'fix: outside' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No owned files/)
    assert.equal(after, before)
  })

  it('rejects a blank commit message without creating a commit', () => {
    writeFileSync(join(TMP, 'owned.txt'), 'owned change')
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: '   ' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /Commit message is required/)
    assert.equal(after, before)
  })

  it('provides friendly error when owned files have no changes', () => {
    // Don't modify owned.txt - it's already committed and clean
    const before = git(['rev-parse', 'HEAD']).trim()
    const result = commitScopedFiles({ cwd: TMP, files: ['owned.txt'], message: 'fix: no changes' })
    const after = git(['rev-parse', 'HEAD']).trim()
    assert.equal(result.ok, false)
    assert.match(result.output, /No changes in owned files to commit/)
    assert.match(result.output, /owned\.txt/)
    assert.equal(after, before)
  })
})
