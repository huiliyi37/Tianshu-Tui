import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, lstatSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { provisionSnapshotDeps, isWorkspaceRepo } from '../snapshot-deps.js'

const tempDirs: string[] = []

function makeBaseAndWorktree(): { base: string; wt: string } {
  const base = mkdtempSync(join(tmpdir(), 'snapdeps-base-'))
  const wt = mkdtempSync(join(tmpdir(), 'snapdeps-wt-'))
  tempDirs.push(base, wt)
  return { base, wt }
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

describe('snapshot-deps — dependency provisioner', () => {
  it('symlinks node_modules from the base repo into the worktree', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules', 'left-pad'), { recursive: true })
    writeFileSync(join(base, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')

    const result = provisionSnapshotDeps(base, wt)

    const nm = result.links.find(l => l.name === 'node_modules')
    assert.equal(nm?.status, 'linked')
    assert.ok(lstatSync(join(wt, 'node_modules')).isSymbolicLink(), 'should be a symlink')
    // Resolves through the symlink to the real tree.
    assert.ok(existsSync(join(wt, 'node_modules', 'left-pad', 'index.js')))
    assert.equal(result.installCommand, undefined)
  })

  it('reports source-absent when the base repo has no node_modules', () => {
    const { base, wt } = makeBaseAndWorktree()
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'source-absent')
    assert.equal(result.links.find(l => l.name === '.venv')?.status, 'source-absent')
  })

  it('symlinks an existing .venv', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, '.venv', 'bin'), { recursive: true })
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === '.venv')?.status, 'linked')
    assert.ok(lstatSync(join(wt, '.venv')).isSymbolicLink())
  })

  it('skips node_modules symlink for a pnpm workspace and recommends install', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules'), { recursive: true })
    writeFileSync(join(base, 'pnpm-workspace.yaml'), 'packages:\n  - "packages/*"\n')

    assert.equal(isWorkspaceRepo(base), true)
    const result = provisionSnapshotDeps(base, wt)

    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'skipped-workspace')
    assert.equal(existsSync(join(wt, 'node_modules')), false, 'no wrong single symlink for workspace')
    assert.deepEqual(result.installCommand, ['pnpm', 'install', '--frozen-lockfile'])
    assert.ok(result.warnings.some(w => w.includes('Workspace')))
  })

  it('skips when the target already exists in the worktree', () => {
    const { base, wt } = makeBaseAndWorktree()
    mkdirSync(join(base, 'node_modules'), { recursive: true })
    mkdirSync(join(wt, 'node_modules'), { recursive: true })
    const result = provisionSnapshotDeps(base, wt)
    assert.equal(result.links.find(l => l.name === 'node_modules')?.status, 'skipped-exists')
  })
})
