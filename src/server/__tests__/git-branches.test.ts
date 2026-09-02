/**
 * P4 补线 — real git branch list + branch-aware session creation.
 *
 * Anti-proof table:
 *   #1 "branches are hardcoded presets" → test 1 reads the real repo.
 *   #2 "worktree ignores the selected branch" → test 3 checks worktreeBranch.
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { Artifact } from '../../artifact/types.js'
import type { OaiMessage } from '../../api/oai-types.js'

const TOKEN = 'tok'
const AUTH = { authorization: `Bearer ${TOKEN}` }

class BranchAgent implements ManagedAgent {
  run(_prompt: string): Promise<void> { return Promise.resolve() }
  finish(): void {}
  abort(): void {}
  listArtifacts(): Artifact[] { return [] }
  readArtifact(): Promise<string | null> { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(): void {}
  rewindToMessages(): void {}
}

function git(cwd: string, args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

function initRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), 'rivet-branches-'))
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  execFileSync('git', ['commit', '--allow-empty', '-m', 'init'], { cwd: dir, stdio: 'pipe' })
  git(dir, ['branch', 'dev'])
  git(dir, ['branch', 'feature/real-branch'])
  return dir
}

test('#1 real branches come from git, not presets', async () => {
  const dir = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: dir })
    const result = await manager.getGitBranches(dir)
    assert.equal(result.notARepo, false)
    assert.equal(result.current, 'main')
    const names = result.branches.map((b) => b.name)
    assert.ok(names.includes('main'))
    assert.ok(names.includes('dev'))
    assert.ok(names.includes('feature/real-branch'))
    assert.equal(result.branches.find((b) => b.name === 'main')?.current, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#2 GET /git/branches returns the real list', async () => {
  const dir = initRepo()
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: dir })
    const router = createRouter(buildSessionRoutes(manager, TOKEN))
    const res = await router('GET', `/git/branches?cwd=${encodeURIComponent(dir)}`, {}, AUTH)
    assert.equal(res.status, 200)
    const body = res.body as { branches?: Array<{ name: string }> }
    assert.ok((body.branches ?? []).some((b) => b.name === 'feature/real-branch'))
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('#3 branch metadata + branch-based worktree round-trip', () => {
  const dir = initRepo()
  let wtPath: string | undefined
  try {
    const manager = new RuntimeSessionManager({ createAgent: () => new BranchAgent(), defaultCwd: dir })
    const rec = manager.createSession({ cwd: dir, branch: 'dev' })
    assert.equal(rec.branch, 'dev')

    const wtRec = manager.createSession({
      cwd: dir,
      isolatedWorktree: true,
      worktreeBaseBranch: 'feature/real-branch',
    })
    wtPath = wtRec.worktreePath
    assert.equal(wtRec.worktreeBranch, 'feature/real-branch')
    assert.ok(wtPath && existsSync(wtPath), 'worktree exists on disk')
    assert.equal(wtRec.branch, 'feature/real-branch')
  } finally {
    if (wtPath) rmSync(wtPath, { recursive: true, force: true })
    rmSync(dir, { recursive: true, force: true })
  }
})
