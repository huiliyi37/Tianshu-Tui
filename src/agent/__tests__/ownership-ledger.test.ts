import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { createOwnershipLedger } from '../ownership-ledger.js'
import { createWorktreeBaseline, type BaselineSnapshot } from '../worktree-baseline.js'
import { createTaskLedger } from '../task-ledger.js'

const baselineSnap: BaselineSnapshot = {
  branch: 'feat/b1',
  head: 'abc123',
  preExistingDirty: ['src/external-dirty.ts'],
  preExistingUntracked: ['temp.log'],
  capturedAt: Date.now(),
}

describe('ownership-ledger — file ownership tracking', () => {
  it('registers and queries owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    assert.equal(ownership.isOwned('src/tools/git.ts'), true)
    assert.equal(ownership.isOwned('src/tools/diff.ts'), true)
    assert.equal(ownership.isOwned('src/other.ts'), false)
  })

  it('pre-existing dirty files are NOT owned', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    // Even if we try to register an external file, it's still external
    ownership.registerOwned('src/external-dirty.ts')
    assert.equal(ownership.isOwned('src/external-dirty.ts'), false)
  })

  it('pre-existing untracked files are NOT owned', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('temp.log')
    assert.equal(ownership.isOwned('temp.log'), false)
  })

  it('getOwnedFiles returns only truly owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')
    ownership.registerOwned('src/external-dirty.ts') // external, should be excluded

    const owned = ownership.getOwnedFiles()
    assert.deepEqual(owned, ['src/tools/diff.ts', 'src/tools/git.ts'])
  })

  it('getExternalFiles returns baseline external files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const external = ownership.getExternalFiles()
    assert.deepEqual(external, ['src/external-dirty.ts', 'temp.log'])
  })

  it('isExternal delegates to baseline', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.isExternal('src/external-dirty.ts'), true)
    assert.equal(ownership.isExternal('temp.log'), true)
    assert.equal(ownership.isExternal('src/my-file.ts'), false)
  })

  it('getOwnershipReport provides structured report', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    const report = ownership.getOwnershipReport()
    assert.equal(report.taskId, 't1')
    assert.deepEqual(report.ownedFiles, ['src/tools/diff.ts', 'src/tools/git.ts'])
    assert.equal(report.ownedFileCount, 2)
    assert.equal(report.externalFileCount, 2) // dirty + untracked
    assert.deepEqual(report.externalFiles, ['src/external-dirty.ts', 'temp.log'])
  })

  it('can scope a file list to only owned files', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/tools/git.ts')
    ownership.registerOwned('src/tools/diff.ts')

    const scoped = ownership.scopeToOwned([
      'src/tools/git.ts',
      'src/tools/diff.ts',
      'src/external-dirty.ts',
      'src/unknown.ts',
    ])

    assert.deepEqual(scoped, ['src/tools/diff.ts', 'src/tools/git.ts'])
  })

  it('isOwned returns false for null/empty input', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    assert.equal(ownership.isOwned(null), false)
    assert.equal(ownership.isOwned(''), false)
  })

  it('autoOwnFromLedger imports owned files from task ledger write events', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't2' })
    ledger.record({ type: 'file_write', path: 'src/a.ts' })
    ledger.record({ type: 'file_write', path: 'src/b.ts' })
    ledger.record({ type: 'file_read', path: 'src/c.ts' }) // read, not write

    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    assert.equal(ownership.isOwned('src/a.ts'), true)
    assert.equal(ownership.isOwned('src/b.ts'), true)
    assert.equal(ownership.isOwned('src/c.ts'), false) // read only
  })

  it('autoOwnFromLedger excludes external files even if written', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/external.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't3' })
    ledger.record({ type: 'file_write', path: 'src/external.ts' })
    ledger.record({ type: 'file_write', path: 'src/owned.ts' })

    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    assert.equal(ownership.isOwned('src/external.ts'), false)
    assert.equal(ownership.isOwned('src/owned.ts'), true)
  })
})
