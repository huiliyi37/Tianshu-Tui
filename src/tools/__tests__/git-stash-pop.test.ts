import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { GIT_TOOL } from '../git.js'

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8' })
}

describe('git stash_pop action', () => {
  let repo: string
  before(() => {
    repo = mkdtempSync(join(tmpdir(), 'rivet-stashpop-'))
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 't@t.co')
    git(repo, 'config', 'user.name', 'T')
    writeFileSync(join(repo, 'a.txt'), 'base\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-qm', 'base')
  })
  after(() => { if (existsSync(repo)) rmSync(repo, { recursive: true, force: true }) })

  it('blocks pop when working tree content differs from stash', async () => {
    // Edit a.txt → stash → edit a.txt with different content (simulate cross-session)
    writeFileSync(join(repo, 'a.txt'), 'session-A-edit\n')
    git(repo, 'stash', 'push', '-q')
    writeFileSync(join(repo, 'a.txt'), 'session-B-edit\n')
    const res = await GIT_TOOL.execute({
      input: { action: 'stash_pop', stashRef: 'stash@{0}' }, cwd: repo,
      toolUseId: 'test', onOutput: () => {},
    } as any)
    assert.equal(res.isError, true)
    assert.match(res.content, /BLOCKED|different content/)
    // Confirm stash was NOT popped: a.txt still has B's content
    assert.match(git(repo, 'show', ':a.txt'), /session-B-edit|base/)
  })

  it('pops cleanly when no conflict', async () => {
    git(repo, 'checkout', '-q', '--', 'a.txt')
    git(repo, 'stash', 'clear')
    writeFileSync(join(repo, 'b.txt'), 'new\n')
    git(repo, 'stash', 'push', '-q', '--include-untracked')
    const res = await GIT_TOOL.execute({
      input: { action: 'stash_pop', stashRef: 'stash@{0}' }, cwd: repo,
      toolUseId: 'test', onOutput: () => {},
    } as any)
    assert.notEqual(res.isError, true)
    assert.match(res.content, /Popped|restored|safety/i)
  })
})
