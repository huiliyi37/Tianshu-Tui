import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseWorktreeList, buildWorktreeArgs } from '../agent/worktree.js'

describe('parseWorktreeList', () => {
  it('parses git worktree list output', () => {
    const output = `/Users/dev/project  abc1234 [main]\n/Users/dev/wt1  def5678 [feat-x]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 2)
    assert.deepEqual(result[0], { path: '/Users/dev/project', commit: 'abc1234', branch: 'main' })
    assert.deepEqual(result[1], { path: '/Users/dev/wt1', commit: 'def5678', branch: 'feat-x' })
  })

  it('returns empty array for empty output', () => {
    assert.equal(parseWorktreeList('').length, 0)
  })

  it('handles detached HEAD', () => {
    const output = `/tmp/wt  1234567 [(HEAD detached at abc1234)]`
    const result = parseWorktreeList(output)
    assert.equal(result.length, 1)
    assert.equal(result[0]!.branch, '(HEAD detached at abc1234)')
  })
})

describe('buildWorktreeArgs', () => {
  it('with branch', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt', 'session-abc'), ['worktree', 'add', '-b', 'session-abc', '/tmp/wt'])
  })

  it('detached', () => {
    assert.deepEqual(buildWorktreeArgs('/tmp/wt'), ['worktree', 'add', '--detach', '/tmp/wt'])
  })
})
