import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { decideSnapshotPolicy } from '../snapshot-policy.js'
import type { SnapshotPolicyInput } from '../snapshot-policy.js'

function base(overrides: Partial<SnapshotPolicyInput> = {}): SnapshotPolicyInput {
  return {
    isGitRepo: true,
    baselineHead: 'abc123def456',
    sameCwdRunningSessions: 0,
    preExistingDirtyCount: 0,
    preExistingUntrackedCount: 0,
    ...overrides,
  }
}

describe('decideSnapshotPolicy — §6 condition matrix', () => {
  it('single session + clean baseline → in-place', () => {
    const d = decideSnapshotPolicy(base())
    assert.equal(d.snapshot, false)
    assert.equal(d.mode, 'in-place')
  })

  it('single session + dirty baseline → snapshot', () => {
    const d = decideSnapshotPolicy(base({ preExistingDirtyCount: 2 }))
    assert.equal(d.snapshot, true)
    assert.equal(d.mode, 'snapshot')
    assert.match(d.reason, /dirty/)
  })

  it('single session + untracked baseline → snapshot', () => {
    const d = decideSnapshotPolicy(base({ preExistingUntrackedCount: 1 }))
    assert.equal(d.snapshot, true)
    assert.match(d.reason, /untracked/)
  })

  it('concurrent session + clean baseline → snapshot', () => {
    const d = decideSnapshotPolicy(base({ sameCwdRunningSessions: 1 }))
    assert.equal(d.snapshot, true)
    assert.match(d.reason, /concurrent/)
  })

  it('concurrent + dirty → snapshot', () => {
    const d = decideSnapshotPolicy(base({ sameCwdRunningSessions: 3, preExistingDirtyCount: 5 }))
    assert.equal(d.snapshot, true)
  })

  it('non-git repo → in-place-degraded (never snapshots)', () => {
    const d = decideSnapshotPolicy(base({ isGitRepo: false, preExistingDirtyCount: 9 }))
    assert.equal(d.snapshot, false)
    assert.equal(d.mode, 'in-place-degraded')
    assert.match(d.reason, /not a git repository/i)
  })

  it('forceSnapshot overrides a clean single session', () => {
    const d = decideSnapshotPolicy(base({ forceSnapshot: true }))
    assert.equal(d.snapshot, true)
    assert.match(d.reason, /forced/i)
  })

  it('snapshot wanted but missing baselineHead → in-place-degraded (no fake-green)', () => {
    const d = decideSnapshotPolicy(base({ preExistingDirtyCount: 1, baselineHead: undefined }))
    assert.equal(d.snapshot, false)
    assert.equal(d.mode, 'in-place-degraded')
    assert.match(d.reason, /no baseline commit/i)
  })

  it('forceSnapshot on non-git still degrades (worktrees need git)', () => {
    const d = decideSnapshotPolicy(base({ forceSnapshot: true, isGitRepo: false }))
    assert.equal(d.snapshot, false)
    assert.equal(d.mode, 'in-place-degraded')
  })

  it('empty-string baselineHead is treated as missing', () => {
    const d = decideSnapshotPolicy(base({ sameCwdRunningSessions: 1, baselineHead: '   ' }))
    assert.equal(d.snapshot, false)
    assert.equal(d.mode, 'in-place-degraded')
  })
})
