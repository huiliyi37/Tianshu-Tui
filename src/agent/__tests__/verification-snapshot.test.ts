import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync, mkdirSync, unlinkSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { createVerificationSnapshot, snapshotPath } from '../verification-snapshot.js'

const tempDirs: string[] = []

function g(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim()
}

/** Git repo with a tracked src/a.ts on an initial commit. Returns {dir, head}. */
function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'vsw-test-'))
  tempDirs.push(dir)
  g(dir, 'git init -b main')
  g(dir, 'git config user.email "test@test"')
  g(dir, 'git config user.name "test"')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "baseline"\n')
  writeFileSync(join(dir, 'README.md'), '# baseline\n')
  g(dir, 'git add -A')
  g(dir, 'git commit -m init')
  return { dir, head: g(dir, 'git rev-parse HEAD') }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try {
      // Clean any worktree registration before removing the dir tree.
      try { execSync('git worktree prune', { cwd: dir, stdio: 'ignore' }) } catch { /* ignore */ }
      rmSync(dir, { recursive: true, force: true })
    } catch { /* ignore */ }
  }
})

describe('verification-snapshot — VSW core', () => {
  it('creates a detached worktree under .rivet/vsw/<sessionId> at baseline.head', () => {
    const { dir, head } = makeRepo()
    const snap = createVerificationSnapshot({ baseCwd: dir, sessionId: 'sess1', baselineHead: head, ownedFiles: [] })

    assert.equal(snap.path, snapshotPath(dir, 'sess1'))
    assert.ok(existsSync(snap.path), 'worktree dir should exist')
    // Detached at baseline.head.
    assert.equal(g(snap.path, 'git rev-parse HEAD'), head)
    const list = g(dir, 'git worktree list --porcelain')
    assert.ok(list.includes(snap.path), 'worktree should be registered')

    snap.destroy()
  })

  it('overlays tracked owned modifications (does NOT skip them like materializeScope would)', () => {
    const { dir, head } = makeRepo()
    // Session edits a tracked file in the live working tree (uncommitted).
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "owned-change"\n')

    const snap = createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess2', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    // 反证: a naive materializeScope overlay would `continue` on the existing
    // baseline file and leave "baseline" content → this asserts the diff applied.
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "owned-change"\n')
    snap.destroy()
  })

  it('materializes untracked-new owned files', () => {
    const { dir, head } = makeRepo()
    writeFileSync(join(dir, 'src', 'new.ts'), 'export const n = 1\n')

    const snap = createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess3', baselineHead: head, ownedFiles: ['src/new.ts'],
    })

    assert.ok(existsSync(join(snap.path, 'src', 'new.ts')), 'untracked owned file should be copied in')
    assert.equal(readFileSync(join(snap.path, 'src', 'new.ts'), 'utf-8'), 'export const n = 1\n')
    snap.destroy()
  })

  it('isolates the snapshot from concurrent non-owned commits (no pollution)', () => {
    const { dir, head } = makeRepo()
    // Owned change.
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "owned-change"\n')
    // Concurrent session advances HEAD with an UNowned change.
    writeFileSync(join(dir, 'README.md'), '# concurrent-pollution\n')
    g(dir, 'git add README.md')
    g(dir, 'git commit -m "concurrent session commit"')

    const snap = createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess4', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    // Owned change present.
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "owned-change"\n')
    // Concurrent commit NOT present — snapshot stays at baseline README.
    assert.equal(readFileSync(join(snap.path, 'README.md'), 'utf-8'), '# baseline\n')
    snap.destroy()
  })

  it('overlays tracked owned deletions', () => {
    const { dir, head } = makeRepo()
    unlinkSync(join(dir, 'src', 'a.ts'))

    const snap = createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess5', baselineHead: head, ownedFiles: ['src/a.ts'],
    })

    assert.equal(existsSync(join(snap.path, 'src', 'a.ts')), false, 'deleted owned file should be absent in snapshot')
    snap.destroy()
  })

  it('refresh rebuilds the tree at the latest owned content', () => {
    const { dir, head } = makeRepo()
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "v1"\n')
    const snap = createVerificationSnapshot({
      baseCwd: dir, sessionId: 'sess6', baselineHead: head, ownedFiles: ['src/a.ts'],
    })
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "v1"\n')

    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = "v2"\n')
    snap.refresh(['src/a.ts'])
    assert.equal(readFileSync(join(snap.path, 'src', 'a.ts'), 'utf-8'), 'export const a = "v2"\n')
    snap.destroy()
  })

  it('destroy removes the worktree and unregisters it', () => {
    const { dir, head } = makeRepo()
    const snap = createVerificationSnapshot({ baseCwd: dir, sessionId: 'sess7', baselineHead: head, ownedFiles: [] })
    assert.ok(existsSync(snap.path))

    snap.destroy()
    assert.equal(existsSync(snap.path), false, 'worktree dir should be gone')
    const list = g(dir, 'git worktree list --porcelain')
    assert.equal(list.includes(snap.path), false, 'worktree should be unregistered')
  })

  it('a stale snapshot at the same path is replaced on create', () => {
    const { dir, head } = makeRepo()
    const first = createVerificationSnapshot({ baseCwd: dir, sessionId: 'dup', baselineHead: head, ownedFiles: [] })
    assert.ok(existsSync(first.path))
    // Create again with the same sessionId — should not throw on the existing path.
    const second = createVerificationSnapshot({ baseCwd: dir, sessionId: 'dup', baselineHead: head, ownedFiles: [] })
    assert.equal(second.path, first.path)
    assert.equal(g(second.path, 'git rev-parse HEAD'), head)
    second.destroy()
  })
})
