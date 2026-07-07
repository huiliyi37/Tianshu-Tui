import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createWorktreeBaseline, type WorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'

describe('worktree-baseline — task-start snapshot for external/owned differentiation', () => {
  it('captures a baseline from pre-existing dirty and untracked files', () => {
    const snapshot: BaselineSnapshot = {
      branch: 'feat/b1',
      head: 'abc123def',
      preExistingDirty: ['src/other-session.ts', 'docs/external.md'],
      preExistingUntracked: ['temp.log'],
      capturedAt: Date.now(),
    }

    const baseline = createWorktreeBaseline(snapshot)

    assert.equal(baseline.getBranch(), 'feat/b1')
    assert.equal(baseline.getHead(), 'abc123def')
  })

  it('isExternal returns true for pre-existing dirty files', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/other-session.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })

    assert.equal(baseline.isExternal('src/other-session.ts'), true)
    assert.equal(baseline.isExternal('src/my-change.ts'), false)
  })

  it('isExternal returns true for pre-existing untracked files', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: [],
      preExistingUntracked: ['temp.log', 'scratch.txt'],
      capturedAt: Date.now(),
    })

    assert.equal(baseline.isExternal('temp.log'), true)
    assert.equal(baseline.isExternal('scratch.txt'), true)
    assert.equal(baseline.isExternal('src/new.ts'), false)
  })

  it('isExternal returns false for null/empty input', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['x.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })

    assert.equal(baseline.isExternal(null), false)
    assert.equal(baseline.isExternal(''), false)
  })

  it('getExternalFiles returns all external files deduplicated and sorted', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/b.ts', 'src/a.ts'],
      preExistingUntracked: ['src/a.ts', 'temp.log'],
      capturedAt: Date.now(),
    })

    const external = baseline.getExternalFiles()
    assert.deepEqual(external, ['src/a.ts', 'src/b.ts', 'temp.log'])
  })

  it('produces a stable baselineHash for integrity', () => {
    const snap: BaselineSnapshot = {
      branch: 'feat/b1',
      head: 'abc123def',
      preExistingDirty: ['src/other.ts'],
      preExistingUntracked: ['temp.log'],
      capturedAt: 1000,
    }

    const b1 = createWorktreeBaseline(snap)
    const b2 = createWorktreeBaseline({ ...snap })

    assert.equal(b1.getBaselineHash(), b2.getBaselineHash())
    assert.equal(b1.getBaselineHash().length, 64) // sha256 hex
  })

  it('baselineHash changes when branch differs', () => {
    const b1 = createWorktreeBaseline({
      branch: 'feat/a', head: 'abc', preExistingDirty: [], preExistingUntracked: [], capturedAt: 1000,
    })
    const b2 = createWorktreeBaseline({
      branch: 'feat/b', head: 'abc', preExistingDirty: [], preExistingUntracked: [], capturedAt: 1000,
    })

    assert.notEqual(b1.getBaselineHash(), b2.getBaselineHash())
  })

  it('baselineHash is stable regardless of capturedAt', () => {
    const b1 = createWorktreeBaseline({
      branch: 'main', head: 'abc', preExistingDirty: [], preExistingUntracked: [], capturedAt: 1000,
    })
    const b2 = createWorktreeBaseline({
      branch: 'main', head: 'abc', preExistingDirty: [], preExistingUntracked: [], capturedAt: 2000,
    })

    // capturedAt is NOT part of the hash — only structural identity matters
    assert.equal(b1.getBaselineHash(), b2.getBaselineHash())
  })

  it('toSnapshot round-trips', () => {
    const snap: BaselineSnapshot = {
      branch: 'feat/x',
      head: 'abc',
      preExistingDirty: ['a.ts'],
      preExistingUntracked: ['b.log'],
      capturedAt: 5000,
    }

    const baseline = createWorktreeBaseline(snap)
    const roundtripped = baseline.toSnapshot()

    assert.equal(roundtripped.branch, snap.branch)
    assert.equal(roundtripped.head, snap.head)
    assert.deepEqual(roundtripped.preExistingDirty, snap.preExistingDirty)
    assert.deepEqual(roundtripped.preExistingUntracked, snap.preExistingUntracked)
  })

  it('counts external files separately from dirty vs untracked', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['a.ts', 'b.ts'],
      preExistingUntracked: ['c.log', 'd.log', 'e.log'],
      capturedAt: Date.now(),
    })

    assert.equal(baseline.getExternalDirtyCount(), 2)
    assert.equal(baseline.getExternalUntrackedCount(), 3)
  })
})
