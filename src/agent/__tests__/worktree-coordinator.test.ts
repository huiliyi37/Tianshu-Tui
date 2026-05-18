import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execSync } from 'node:child_process'
import { WorktreeCoordinator } from '../worktree-coordinator.js'

function initGitRepo(dir: string): void {
  execSync('git init -b main', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.email "test@test"', { cwd: dir, stdio: 'pipe' })
  execSync('git config user.name "Test"', { cwd: dir, stdio: 'pipe' })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A && git commit -m "init"', { cwd: dir, stdio: 'pipe' })
}

describe('WorktreeCoordinator', () => {
  let baseDir: string
  let coordinator: WorktreeCoordinator

  before(() => {
    baseDir = mkdtempSync(join(tmpdir(), 'rivet-wtc-base-'))
    initGitRepo(baseDir)
    coordinator = new WorktreeCoordinator(baseDir)
  })

  after(() => {
    coordinator.cleanupAll()
    rmSync(baseDir, { recursive: true, force: true })
  })

  it('creates a worktree for a worker session and returns the path', () => {
    const wt = coordinator.create('worker-aaa')
    assert.ok(existsSync(wt.path), `worktree path must exist: ${wt.path}`)
    assert.ok(wt.path.includes('rivet-wt-'), `path should include rivet-wt- prefix: ${wt.path}`)
    assert.ok(wt.branch.startsWith('rivet-hands-'), `branch should start with rivet-hands-: ${wt.branch}`)
    coordinator.remove('worker-aaa')
  })

  it('removes a worktree by worker id', () => {
    const wt = coordinator.create('worker-bbb')
    const wtPath = wt.path
    assert.ok(existsSync(wtPath))
    coordinator.remove('worker-bbb')
    // Worktree directory should be removed
    assert.equal(existsSync(wtPath), false)
  })

  it('cleanupAll removes all active worktrees', () => {
    const wt1 = coordinator.create('worker-ccc')
    const wt2 = coordinator.create('worker-ddd')
    assert.ok(existsSync(wt1.path))
    assert.ok(existsSync(wt2.path))
    coordinator.cleanupAll()
    assert.equal(existsSync(wt1.path), false)
    assert.equal(existsSync(wt2.path), false)
  })

  it('tracks active worktrees per worker id', () => {
    const wt = coordinator.create('worker-eee')
    assert.equal(coordinator.getActiveCount(), 1)
    coordinator.remove('worker-eee')
    assert.equal(coordinator.getActiveCount(), 0)
  })

  it('getWorktree returns handle for active worktree', () => {
    const wt = coordinator.create('worker-fff')
    const handle = coordinator.getWorktree('worker-fff')
    assert.ok(handle)
    assert.equal(handle.path, wt.path)
    assert.equal(handle.branch, wt.branch)
    coordinator.remove('worker-fff')
  })

  it('getWorktree returns undefined for unknown worker id', () => {
    assert.equal(coordinator.getWorktree('nonexistent'), undefined)
  })

  it('removing unknown worker id is a no-op', () => {
    // Should not throw
    coordinator.remove('nonexistent')
    assert.equal(coordinator.getActiveCount(), 0)
  })
})
