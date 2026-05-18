import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { spawnSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'

function git(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) {
    throw new Error(`git ${args.join(' ')} failed: ${result.stderr}`)
  }
  return result.stdout
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# test\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
}

describe('diff-collector', () => {
  let baseDir: string
  let wtDir: string

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-diff-base-'))
    initGitRepo(baseDir)
    // Create a worktree for the "worker" to write into
    wtDir = mkdtempSync(join(tmpdir(), 'rivet-diff-wt-'))
    git(baseDir, ['worktree', 'add', '-b', 'rivet-hands-test', wtDir])
  })

  after(() => {
    try { git(baseDir, ['worktree', 'remove', '--force', wtDir]) } catch {}
    try { git(baseDir, ['branch', '-D', 'rivet-hands-test']) } catch {}
    rmSync(baseDir, { recursive: true, force: true })
    rmSync(wtDir, { recursive: true, force: true })
  })

  it('collects diff from worker worktree as git diff between worker branch and base', () => {
    // Simulate worker writing a file in the worktree
    mkdirSync(join(wtDir, 'src'), { recursive: true })
    writeFileSync(join(wtDir, 'src', 'new-file.ts'), 'export const x = 1\n')

    git(wtDir, ['add', '-A'])
    git(wtDir, ['commit', '-m', 'worker change'])

    const diff = collectDiff(baseDir, wtDir, 'main')
    assert.ok(diff.length > 0, 'diff should be non-empty')
    assert.ok(diff.includes('new-file.ts'), `diff should mention changed file, got: ${diff.slice(0, 200)}`)

    const artifact = formatDiffArtifact(diff, 'patcher')
    assert.equal(artifact.kind, 'diff')
    assert.ok(artifact.title.includes('new-file.ts'), `title should include filename: ${artifact.title}`)
    assert.equal(artifact.content, diff)
  })

  it('returns empty string when no changes in worker worktree vs base', () => {
    // After the commit above, diff vs same branch should be empty
    const diff = collectDiff(baseDir, wtDir, 'rivet-hands-test')
    assert.equal(diff, '')
  })

  it('formats empty diffs as schema-valid artifacts', () => {
    const artifact = formatDiffArtifact('', 'patcher')
    assert.equal(artifact.kind, 'diff')
    assert.equal(artifact.title, 'Patch (empty)')
    assert.equal(artifact.content, '(empty diff)')
  })

  it('handles nonexistent branches gracefully', () => {
    const diff = collectDiff(baseDir, wtDir, 'nonexistent-branch')
    // Should not throw, returns empty string on error
    assert.equal(diff, '')
  })
})
