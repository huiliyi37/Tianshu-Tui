import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { getGitChangeRate, smoothChangeRate } from '../git-freshness.js'

type FileEntry = [string, string]

const tempDirs: string[] = []

function makeGitRepo(commits: FileEntry[][]): string {
  const dir = mkdtempSync(join(tmpdir(), 'git-fresh-test-'))
  tempDirs.push(dir)
  execSync('git init && git config user.email "test@test" && git config user.name "test"', { cwd: dir })
  for (const files of commits) {
    for (const [name, content] of files) {
      writeFileSync(join(dir, name), content)
      execSync(`git add "${name}"`, { cwd: dir })
    }
    execSync(`git commit --allow-empty -m "commit"`, { cwd: dir })
  }
  return dir
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('getGitChangeRate', () => {
  it('returns 0 for a repo with only one commit (no history to diff)', async () => {
    const dir = makeGitRepo([]) // just init, no extra commits
    // git init creates an initial empty commit via --allow-empty in makeGitRepo
    // Actually there's zero commits if we don't pass any. Let's fix:
    const dir2 = makeGitRepo([[]]) // one empty commit
    const rate = await getGitChangeRate(dir2, 5)
    assert.equal(rate, 0)
  })

  it('returns > 0 when files were recently changed', async () => {
    const dir = makeGitRepo([
      [],
      [['a.ts', 'export const a = 1\n']],
      [['b.ts', 'export const b = 2\n']],
    ])
    // 2 files changed in last 5 commits, each tracked
    const rate = await getGitChangeRate(dir, 5)
    assert.ok(rate > 0, `expected > 0, got ${rate}`)
    assert.ok(rate <= 1, `expected <= 1, got ${rate}`)
  })

  it('returns fractional ratio when some files unchanged', async () => {
    // Simple 2-commit repo: a.ts modified, b.ts unchanged
    const dir = makeGitRepo([
      [['a.ts', 'a'], ['b.ts', 'b']],
      [['a.ts', 'a2']],
    ])
    // HEAD~1 = commit 1 (a.ts, b.ts). HEAD = commit 2 (a.ts modified).
    // Diff: a.ts changed, b.ts unchanged → 1/2 = 0.5
    const rate = await getGitChangeRate(dir, 5)
    assert.ok(rate > 0, `expected > 0, got ${rate}`)
    assert.ok(rate < 1, `expected < 1 (b.ts unchanged), got ${rate}`)
  })

  it('returns 0 for non-git directory', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'git-fresh-nogit-'))
    tempDirs.push(dir)
    const rate = await getGitChangeRate(dir)
    assert.equal(rate, 0)
  })

  it('handles fewer commits than lookback gracefully', async () => {
    const dir = makeGitRepo([
      [['x.ts', 'export const x = 1\n']],
      [['y.ts', 'export const y = 2\n']],
    ])
    // lookback 10 but only 2 commits exist — should still work
    const rate = await getGitChangeRate(dir, 10)
    assert.ok(rate >= 0 && rate <= 1)
  })

  it('returns 1 when all tracked files changed', async () => {
    const dir = makeGitRepo([
      [['a.ts', 'a'], ['b.ts', 'b']],
      [['a.ts', 'a2'], ['b.ts', 'b2'], ['c.ts', 'c']],
    ])
    // all 3 files changed in last commit relative to HEAD~5
    const rate = await getGitChangeRate(dir, 5)
    assert.equal(rate, 1)
  })
})

describe('smoothChangeRate', () => {
  it('applies exponential moving average', () => {
    const result = smoothChangeRate(0.8, 0.2, 0.3)
    const expected = 0.3 * 0.8 + 0.7 * 0.2
    assert.ok(Math.abs(result - expected) < 0.001)
  })

  it('clamps to 0-1', () => {
    // raw=1.5→clamped to 1, then EMA: 0.5*1 + 0.5*0 = 0.5
    assert.equal(smoothChangeRate(1.5, 0, 0.5), 0.5)
    // raw=-0.5→clamped to 0, then EMA: 0.5*0 + 0.5*0 = 0
    assert.equal(smoothChangeRate(-0.5, 0, 0.5), 0)
  })

  it('performs identity when alpha is 1', () => {
    const result = smoothChangeRate(0.7, 0.3, 1)
    assert.ok(Math.abs(result - 0.7) < 0.001)
  })

  it('preserves previous when alpha is 0', () => {
    const result = smoothChangeRate(0.7, 0.3, 0)
    assert.ok(Math.abs(result - 0.3) < 0.001)
  })
})
