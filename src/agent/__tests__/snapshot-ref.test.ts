import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { execSync } from 'node:child_process'
import { computeSnapshotRef, computeOwnedDiff, snapshotRefFor } from '../snapshot-ref.js'

const tempDirs: string[] = []

function g(cwd: string, cmd: string): string {
  return execSync(cmd, { cwd, encoding: 'utf-8' }).trim()
}

function makeRepo(): { dir: string; head: string } {
  const dir = mkdtempSync(join(tmpdir(), 'snapref-test-'))
  tempDirs.push(dir)
  g(dir, 'git init -b main')
  g(dir, 'git config user.email "t@t"')
  g(dir, 'git config user.name "t"')
  mkdirSync(join(dir, 'src'), { recursive: true })
  writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 1\n')
  g(dir, 'git add -A')
  g(dir, 'git commit -m init')
  return { dir, head: g(dir, 'git rev-parse HEAD') }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('snapshot-ref — content-addressed identity', () => {
  it('computeSnapshotRef is deterministic and diff-sensitive', () => {
    const a = computeSnapshotRef('abc123def456', 'diff-x')
    const b = computeSnapshotRef('abc123def456', 'diff-x')
    const c = computeSnapshotRef('abc123def456', 'diff-y')
    assert.equal(a, b)
    assert.notEqual(a, c)
    assert.ok(a.startsWith('abc123def456'.slice(0, 12) + '+'))
  })

  it('changes when the owned diff changes', () => {
    const { dir, head } = makeRepo()
    const before = snapshotRefFor(dir, head, ['src/a.ts'])
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 999\n')
    const after = snapshotRefFor(dir, head, ['src/a.ts'])
    assert.notEqual(before, after)
  })

  it('stable when owned files are unchanged', () => {
    const { dir, head } = makeRepo()
    writeFileSync(join(dir, 'src', 'a.ts'), 'export const a = 2\n')
    const first = snapshotRefFor(dir, head, ['src/a.ts'])
    const second = snapshotRefFor(dir, head, ['src/a.ts'])
    assert.equal(first, second)
  })

  it('computeOwnedDiff returns empty for no owned files', () => {
    const { dir, head } = makeRepo()
    assert.equal(computeOwnedDiff(dir, head, []), '')
  })
})
