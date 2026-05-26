import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, existsSync, mkdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { spawnSync } from 'node:child_process'
import { materializeScope } from '../worktree-scope.js'

function git(cwd: string, args: string[]) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  return result
}

function gitOutput(cwd: string, args: string[]): string {
  return git(cwd, args).stdout.trim()
}

describe('materializeScope', () => {
  let repoDir: string
  let wtDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'scope-repo-'))
    git(repoDir, ['init', '-b', 'main'])
    git(repoDir, ['config', 'user.email', 'test@test.com'])
    git(repoDir, ['config', 'user.name', 'Test'])
    writeFileSync(join(repoDir, 'tracked.ts'), 'export const x = 1')
    git(repoDir, ['add', '.'])
    git(repoDir, ['commit', '-m', 'init'])
    wtDir = mkdtempSync(join(tmpdir(), 'scope-wt-'))
    rmSync(wtDir, { recursive: true, force: true })
    git(repoDir, ['worktree', 'add', '-b', 'test-wt', wtDir])
  })

  afterEach(() => {
    try { git(repoDir, ['worktree', 'remove', '--force', wtDir]) } catch {}
    rmSync(repoDir, { recursive: true, force: true })
  })

  it('leaves tracked files alone when already visible in worktree', () => {
    const result = materializeScope(repoDir, wtDir, ['tracked.ts'])
    assert.deepEqual(result, { materialized: [], missing: [] })
  })

  it('copies untracked relative files into worker worktree', () => {
    writeFileSync(join(repoDir, 'plan.md'), '# Plan')

    const result = materializeScope(repoDir, wtDir, ['plan.md'])

    assert.deepEqual(result.materialized, ['plan.md'])
    assert.deepEqual(result.missing, [])
    assert.ok(existsSync(join(wtDir, 'plan.md')))
    const excludePath = gitOutput(wtDir, ['rev-parse', '--git-path', 'info/exclude'])
    assert.match(readFileSync(excludePath, 'utf-8'), /\/plan\.md/)
  })

  it('copies untracked absolute files when they are inside the repo', () => {
    const absolute = join(repoDir, 'docs', 'plan.md')
    mkdirSync(join(repoDir, 'docs'), { recursive: true })
    writeFileSync(absolute, '# Plan')

    const result = materializeScope(repoDir, wtDir, [absolute])

    assert.deepEqual(result.materialized, ['docs/plan.md'])
    assert.ok(existsSync(join(wtDir, 'docs', 'plan.md')))
  })

  it('reports files outside repo as missing', () => {
    const result = materializeScope(repoDir, wtDir, ['/etc/passwd'])
    assert.equal(result.missing.length, 1)
    assert.equal(result.materialized.length, 0)
  })

  it('reports missing relative files', () => {
    const result = materializeScope(repoDir, wtDir, ['missing.md'])
    assert.deepEqual(result.missing, ['missing.md'])
  })
})
