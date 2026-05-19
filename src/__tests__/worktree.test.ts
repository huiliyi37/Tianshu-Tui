import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { parseWorktreeList, buildWorktreeArgs, getCurrentGitRef } from '../agent/worktree.js'

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initGitRepo(dir: string, branch = 'main'): void {
  git(dir, ['init', '-b', branch])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# test\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
}

describe('parseWorktreeList', () => {
  it('parses git worktree list output', () => {
    const output = `/Users/dev/project  abc1234 [main]\n/Users/dev/wt1  def5678 [feat-x]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], { path: '/Users/dev/project', commit: 'abc1234', branch: 'main' })
    assert.deepEqual(result[1], { path: '/Users/dev/wt1', commit: 'def5678', branch: 'feat-x' })
  })

  it('parses porcelain output with paths containing spaces', () => {
    const output = `worktree /Users/dev/project with space\nHEAD abc1234\nbranch refs/heads/main\n\nworktree /Users/dev/wt1\nHEAD def5678\nbranch refs/heads/feat-x\n`
    const result = parseWorktreeList(output)
    assert.deepEqual(result, [
      { path: '/Users/dev/project with space', commit: 'abc1234', branch: 'main' },
      { path: '/Users/dev/wt1', commit: 'def5678', branch: 'feat-x' },
    ])
  })

  it('returns empty array for empty output', () => {
    assert.equal(parseWorktreeList('').length, 0)
  })

  it('handles detached HEAD', () => {
    const output = `/tmp/wt  1234567 [(HEAD detached at abc1234)]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.branch, '(HEAD detached at abc1234)')
  })
})

describe('buildWorktreeArgs', () => {
  it('with branch', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt', 'session-abc'), ['worktree', 'add', '-b', 'session-abc', '/tmp/wt'])
  })

  it('detached', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt'), ['worktree', 'add', '--detach', '/tmp/wt'])
  })
})

describe('getCurrentGitRef', () => {
  let repo: string

  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-current-ref-'))
    initGitRepo(repo, 'feature-base')
  })

  after(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  it('returns the current branch instead of assuming main', () => {
    assert.equal(getCurrentGitRef(repo), 'feature-base')
  })
})
