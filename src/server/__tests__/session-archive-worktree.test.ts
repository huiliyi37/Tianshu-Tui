import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { RuntimeSessionManager, type ManagedAgent } from '../session-manager.js'
import { buildSessionRoutes } from '../session-routes.js'
import { createRouter } from '../index.js'
import type { AgentCallbacks } from '../../agent/loop-types.js'
import type { OaiMessage } from '../../api/oai-types.js'

function git(dir: string, args: string[]): string {
  return execFileSync('git', args, { cwd: dir, encoding: 'utf-8', stdio: ['ignore', 'pipe', 'pipe'] })
}

function initGitRepo(dir: string): void {
  git(dir, ['init', '-b', 'main'])
  git(dir, ['config', 'user.email', 'test@test'])
  git(dir, ['config', 'user.name', 'Test'])
  writeFileSync(join(dir, 'README.md'), '# test\n')
  git(dir, ['add', '-A'])
  git(dir, ['commit', '-m', 'init'])
}

class NoopAgent implements ManagedAgent {
  run(_p: string, _cb: AgentCallbacks) { return Promise.resolve() }
  abort() {}
  listArtifacts() { return [] }
  readArtifact(_id: string) { return Promise.resolve(null) }
  getMessages(): OaiMessage[] { return [] }
  replaceMessages(_msgs: OaiMessage[]): void {}
  rewindToMessages(_msgs: OaiMessage[]): void {}
}

let repo: string

before(() => {
  repo = mkdtempSync(join(tmpdir(), 'rivet-archive-guard-'))
  initGitRepo(repo)
})

after(() => {
  rmSync(repo, { recursive: true, force: true })
})

function makeManager() {
  return new RuntimeSessionManager({
    createAgent: () => new NoopAgent(),
    defaultCwd: repo,
  })
}

test('archive keeps the worktree branch when uncommitted work exists (checkpoint commit)', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath, 'worktree created')
  assert.ok(rec.worktreeBranch, 'worktree branch created')

  // Simulate agent work left uncommitted.
  writeFileSync(join(rec.worktreePath!, 'wip.txt'), 'unlanded\n')

  assert.equal(manager.archiveSession(rec.id), true)

  // Worktree dir removed, branch preserved with a checkpoint commit.
  assert.equal(existsSync(rec.worktreePath!), false)
  const branches = git(repo, ['branch', '--list', rec.worktreeBranch!]).trim()
  assert.ok(branches.includes(rec.worktreeBranch!), 'branch survives archive')
  const subject = git(repo, ['log', '-1', '--format=%s', rec.worktreeBranch!]).trim()
  assert.equal(subject, 'rivet: archive checkpoint')
  const files = git(repo, ['show', '--stat', '--format=', rec.worktreeBranch!])
  assert.ok(files.includes('wip.txt'))

  git(repo, ['branch', '-D', rec.worktreeBranch!])
})

test('archive deletes the branch when the worktree is clean and fully merged', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath)

  assert.equal(manager.archiveSession(rec.id), true)

  assert.equal(existsSync(rec.worktreePath!), false)
  const branches = git(repo, ['branch', '--list', rec.worktreeBranch!]).trim()
  assert.equal(branches, '', 'clean branch is deleted as before')
})

test('session-scoped git context: worktree cwd + baseline diff keeps committed work visible', async () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath)
  assert.ok(rec.baselineHead, 'baselineHead recorded at creation')

  // Commit part of the work in the worktree, leave the rest dirty.
  writeFileSync(join(rec.worktreePath!, 'committed.txt'), 'a\n')
  git(rec.worktreePath!, ['add', '-A'])
  git(rec.worktreePath!, ['commit', '-m', 'mid-task'])
  writeFileSync(join(rec.worktreePath!, 'wip.txt'), 'b\n')

  const tree = await manager.getSessionWorkingTree(rec.id)
  assert.ok(tree)
  const paths = tree!.files.map(f => f.path).sort()
  assert.deepEqual(paths, ['committed.txt', 'wip.txt'], 'both committed and dirty files visible vs baseline; owner marker hidden')

  const diff = await manager.getSessionFileDiff(rec.id, 'committed.txt')
  assert.ok(diff && diff.includes('+a'), 'committed change diffs against baseline')

  // Unknown session → null (route maps to 404).
  assert.equal(await manager.getSessionWorkingTree('ghost'), null)
  assert.equal(await manager.getSessionFileDiff('ghost', 'x'), null)

  manager.archiveSession(rec.id)
  git(repo, ['branch', '-D', rec.worktreeBranch!])
})

test('landing: commitSessionChanges commits the worktree and emits a landing event', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath)

  writeFileSync(join(rec.worktreePath!, 'feature.txt'), 'x\n')
  const result = manager.commitSessionChanges(rec.id, 'add feature file')
  assert.ok(result)
  assert.equal(result!.ok, true)
  assert.ok(result!.sha)

  const subject = git(rec.worktreePath!, ['log', '-1', '--format=%s']).trim()
  assert.equal(subject, 'add feature file')

  const events = manager.getEvents(rec.id, 0)
  assert.ok(events?.events.some(e => e.type === 'landing' && e.data.action === 'commit'), 'landing event emitted')

  // Second call with a clean tree → nothingToCommit, no error.
  const again = manager.commitSessionChanges(rec.id)
  assert.equal(again!.ok, true)
  assert.equal(again!.nothingToCommit, true)

  manager.archiveSession(rec.id)
  git(repo, ['branch', '-D', rec.worktreeBranch!])
})

test('landing: mergeSessionBack squash-merges committed + uncommitted work into main', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath)

  writeFileSync(join(rec.worktreePath!, 'committed.txt'), 'a\n')
  git(rec.worktreePath!, ['add', '-A'])
  git(rec.worktreePath!, ['commit', '-m', 'part one'])
  writeFileSync(join(rec.worktreePath!, 'uncommitted.txt'), 'b\n')

  const result = manager.mergeSessionBack(rec.id)
  assert.ok(result)
  assert.equal(result!.error, undefined)
  assert.equal(result!.ok, true)
  assert.ok(result!.sha)

  // Main workspace now contains both files in a single squash commit.
  const show = git(repo, ['show', '--stat', '--format=%s', 'HEAD'])
  assert.ok(show.includes('rivet session'))
  assert.ok(show.includes('committed.txt'))
  assert.ok(show.includes('uncommitted.txt'))

  // After merge, archive can delete the branch (fully merged, clean).
  manager.archiveSession(rec.id)
  const branches = git(repo, ['branch', '--list', rec.worktreeBranch!]).trim()
  assert.equal(branches, '', 'merged branch is cleaned up on archive')

  // Reset main so later tests see a stable baseline.
  git(repo, ['reset', '--hard', 'HEAD~1'])
})

test('landing: mergeSessionBack refuses when the main workspace is dirty', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  writeFileSync(join(rec.worktreePath!, 'w.txt'), 'w\n')
  writeFileSync(join(repo, 'dirty-main.txt'), 'dirty\n')
  try {
    const result = manager.mergeSessionBack(rec.id)
    assert.equal(result!.ok, false)
    assert.match(result!.error ?? '', /uncommitted changes/)
  } finally {
    rmSync(join(repo, 'dirty-main.txt'), { force: true })
    manager.archiveSession(rec.id)
    try { git(repo, ['branch', '-D', rec.worktreeBranch!]) } catch { /* may not exist */ }
  }
})

test('landing: mergeSessionBack rolls back on conflict and reports files', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  // Conflicting edits to README.md on both sides.
  writeFileSync(join(rec.worktreePath!, 'README.md'), '# session version\n')
  git(rec.worktreePath!, ['add', '-A'])
  git(rec.worktreePath!, ['commit', '-m', 'session edit'])
  writeFileSync(join(repo, 'README.md'), '# main version\n')
  git(repo, ['add', '-A'])
  git(repo, ['commit', '-m', 'main edit'])

  try {
    const result = manager.mergeSessionBack(rec.id)
    assert.equal(result!.ok, false)
    assert.deepEqual(result!.conflictFiles, ['README.md'])
    // Rolled back: main tree is clean again.
    const status = git(repo, ['status', '--porcelain']).trim()
    assert.equal(status, '', 'main workspace clean after conflict rollback')
  } finally {
    manager.archiveSession(rec.id)
    try { git(repo, ['branch', '-D', rec.worktreeBranch!]) } catch { /* kept branch */ }
    git(repo, ['reset', '--hard', 'HEAD~1'])
  }
})

test('landing: mergeSessionBack and createSessionPr refuse non-worktree sessions', async () => {
  const manager = makeManager()
  const rec = manager.createSession({})
  const merge = manager.mergeSessionBack(rec.id)
  assert.equal(merge!.ok, false)
  assert.match(merge!.error ?? '', /not a worktree session/)
  const pr = await manager.createSessionPr(rec.id)
  assert.equal(pr!.ok, false)
  assert.match(pr!.error ?? '', /not a worktree session/)
  // Unknown session → null.
  assert.equal(manager.commitSessionChanges('ghost'), null)
  assert.equal(manager.mergeSessionBack('ghost'), null)
  assert.equal(await manager.createSessionPr('ghost'), null)
})

test('routes: session-scoped git endpoints dispatch and land changes', async () => {
  const manager = makeManager()
  const TOKEN = 'secret-token'
  const AUTH = { authorization: `Bearer ${TOKEN}` }
  const router = createRouter(buildSessionRoutes(manager, TOKEN))
  const rec = manager.createSession({ isolatedWorktree: true })
  writeFileSync(join(rec.worktreePath!, 'via-route.txt'), 'r\n')

  const tree = await router('GET', `/sessions/${rec.id}/git/working-tree`, {}, AUTH)
  assert.equal(tree.status, 200)
  const files = (tree.body as { files: { path: string }[] }).files
  assert.ok(files.some(f => f.path === 'via-route.txt'))

  const diff = await router('GET', `/sessions/${rec.id}/git/diff?path=via-route.txt`, {}, AUTH)
  assert.equal(diff.status, 200)
  assert.ok((diff.body as { diff: string }).diff.includes('+r'))

  const commit = await router('POST', `/sessions/${rec.id}/git/commit`, { message: 'via route' }, AUTH)
  assert.equal(commit.status, 200)
  assert.equal((commit.body as { ok: boolean }).ok, true)

  const merge = await router('POST', `/sessions/${rec.id}/git/merge-back`, {}, AUTH)
  assert.equal(merge.status, 200)
  assert.equal((merge.body as { ok: boolean }).ok, true)

  // Unknown session → 404; non-worktree merge → 409.
  const ghost = await router('GET', '/sessions/ghost/git/working-tree', {}, AUTH)
  assert.equal(ghost.status, 404)
  const plain = manager.createSession({})
  const badMerge = await router('POST', `/sessions/${plain.id}/git/merge-back`, {}, AUTH)
  assert.equal(badMerge.status, 409)

  manager.archiveSession(rec.id)
  try { git(repo, ['branch', '-D', rec.worktreeBranch!]) } catch { /* already deleted */ }
  git(repo, ['reset', '--hard', 'HEAD~1'])
})

test('archive keeps the branch when it has committed but unmerged work', () => {
  const manager = makeManager()
  const rec = manager.createSession({ isolatedWorktree: true })
  assert.ok(rec.worktreePath)

  writeFileSync(join(rec.worktreePath!, 'done.txt'), 'committed work\n')
  git(rec.worktreePath!, ['add', '-A'])
  git(rec.worktreePath!, ['commit', '-m', 'session work'])

  assert.equal(manager.archiveSession(rec.id), true)

  const branches = git(repo, ['branch', '--list', rec.worktreeBranch!]).trim()
  assert.ok(branches.includes(rec.worktreeBranch!), 'branch with unmerged commits survives')
  const subject = git(repo, ['log', '-1', '--format=%s', rec.worktreeBranch!]).trim()
  assert.equal(subject, 'session work', 'no extra checkpoint commit when tree is clean')

  git(repo, ['branch', '-D', rec.worktreeBranch!])
})
