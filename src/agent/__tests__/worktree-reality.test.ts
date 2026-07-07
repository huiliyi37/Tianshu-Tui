import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { detectWorktreeReality } from '../worktree-reality.js'

const tempDirs: string[] = []

/** Create a temporary git repo with one commit on branch 'main'. */
function makeGitRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-reality-test-'))
  tempDirs.push(dir)
  execSync('git init -b main', { cwd: dir })
  execSync('git config user.email "test@test"', { cwd: dir })
  execSync('git config user.name "test"', { cwd: dir })
  writeFileSync(join(dir, 'README.md'), '# test\n')
  execSync('git add -A', { cwd: dir })
  execSync('git commit -m "init"', { cwd: dir })
  return dir
}

/** Create a bare temporary directory (not a git repo). */
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'worktree-reality-test-'))
  tempDirs.push(dir)
  return dir
}

/** Read current HEAD hash from a git repo. */
function getHead(dir: string): string {
  return execSync('git rev-parse HEAD', { cwd: dir, encoding: 'utf-8' }).trim()
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore cleanup failures */
    }
  }
})

describe('detectWorktreeReality', () => {
  // ── A. CWD 不存在 ──────────────────────────────────────
  it('returns red when cwd does not exist', async () => {
    const result = await detectWorktreeReality(
      '/nonexistent/path/that/does/not/exist',
    )
    assert.equal(result.severity, 'red')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.statusAvailable, false)
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('cwd does not exist')),
    )
  })

  // ── B. 非 git repo（无注入上下文）→ green ─────────────
  it('returns green when cwd exists but is not a git repo and no injected context', async () => {
    const dir = makeTempDir()
    const result = await detectWorktreeReality(dir)
    assert.equal(result.severity, 'green')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.statusAvailable, false)
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  // ── C. 非 git repo + 注入 isGitRepo=true → red ─────────
  it('returns red when injected says isGitRepo=true but cwd is not a git repo', async () => {
    const dir = makeTempDir()
    const result = await detectWorktreeReality(dir, { isGitRepo: true })
    assert.equal(result.severity, 'red')
    assert.equal(result.isGitRepo, false)
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('isGitRepo')),
    )
  })

  // ── D. 有效 git repo，无注入上下文 → green ─────────────
  it('returns green for valid git repo with no injected context', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir)
    assert.equal(result.severity, 'green')
    assert.equal(result.isGitRepo, true)
    assert.equal(result.statusAvailable, true)
    assert.ok(result.repoRoot)
    assert.equal(result.branch, 'main')
    assert.ok(result.head)
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  // ── E. 注入上下文完全匹配 → green ─────────────────────
  it('returns green when injected context matches reality', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      cwd: dir,
      branch: 'main',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'green')
    assert.equal(result.injectedContextMatchesReality, true)
    assert.equal(result.mismatchReasons.length, 0)
  })

  // ── F. Branch 不匹配 → yellow ──────────────────────────
  it('returns yellow on branch mismatch', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      branch: 'wrong-branch',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'yellow')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('branch mismatch')),
    )
    assert.equal(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
      false,
    )
  })

  // ── G. HEAD 不匹配 → red ───────────────────────────────
  it('returns red on HEAD mismatch', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      head: '0000000000000000000000000000000000000000',
      branch: 'main',
      isGitRepo: true,
    })
    assert.equal(result.severity, 'red')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
    )
  })

  // ── H. CWD 不匹配 → yellow ────────────────────────────
  it('returns yellow on cwd mismatch', async () => {
    const dir = makeGitRepo()
    const head = getHead(dir)
    const result = await detectWorktreeReality(dir, {
      cwd: '/some/other/path',
      branch: 'main',
      head,
      isGitRepo: true,
    })
    assert.equal(result.severity, 'yellow')
    assert.ok(
      result.mismatchReasons.some(r => r.includes('cwd mismatch')),
    )
  })

  // ── I. HEAD + Branch 同时不匹配 → red ─────────────────
  it('returns red when HEAD and branch both mismatch', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      head: '0000000000000000000000000000000000000000',
      branch: 'wrong-branch',
      isGitRepo: true,
    })
    assert.equal(result.severity, 'red')
    assert.ok(
      result.mismatchReasons.some(r => r.includes('HEAD mismatch')),
    )
    assert.ok(
      result.mismatchReasons.some(r => r.includes('branch mismatch')),
    )
  })

  // ── J. isGitRepo 反向不匹配 → yellow ──────────────────
  it('returns yellow when injected says isGitRepo=false but actual is a git repo', async () => {
    const dir = makeGitRepo()
    const result = await detectWorktreeReality(dir, {
      isGitRepo: false,
    })
    assert.equal(result.severity, 'yellow')
    assert.equal(result.injectedContextMatchesReality, false)
    assert.ok(
      result.mismatchReasons.some(r => r.includes('isGitRepo')),
    )
  })
})
