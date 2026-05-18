import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { collectDiff, formatDiffArtifact } from '../diff-collector.js'

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

describe('diff-collector', () => {
  let baseDir: string
  let wtDir: string

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-diff-base-'))
    initGitRepo(baseDir)
    // Create a worktree for the "worker" to write into
    wtDir = mkdtempSync(join(tmpdir(), 'rivet-diff-wt-'))
    execSync(`git worktree add -b rivet-hands-test "${wtDir}"`, { cwd: baseDir, stdio: 'pipe' })
  })

  after(() => {
    execSync(`git worktree remove --force "${wtDir}"`, { cwd: baseDir, stdio: 'pipe' })
    try { execSync('git branch -D rivet-hands-test', { cwd: baseDir, stdio: 'pipe' }) } catch {}
    rmSync(baseDir, { recursive: true, force: true })
    rmSync(wtDir, { recursive: true, force: true })
  })

  it('collects diff from worker worktree as git diff between worker branch and base', () => {
    // Simulate worker writing a file in the worktree
    mkdirSync(join(wtDir, 'src'), { recursive: true })
    writeFileSync(join(wtDir, 'src', 'new-file.ts'), 'export const x = 1\n')

    execSync('git add -A && git commit -m "worker change"', { cwd: wtDir, stdio: 'pipe' })

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

  it('handles nonexistent branches gracefully', () => {
    const diff = collectDiff(baseDir, wtDir, 'nonexistent-branch')
    // Should not throw, returns empty string on error
    assert.equal(typeof diff, 'string')
  })
})
