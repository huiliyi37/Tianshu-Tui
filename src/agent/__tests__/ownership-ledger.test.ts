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

  // ── P1 living baseline: getExternalFiles(currentDirtyFiles) dynamic reclassification ──

  it('getExternalFiles(currentDirtyFiles) includes unclassified dirty file as dynamic external', () => {
    // Scenario: another session created src/new-session-file.ts after our baseline.
    // It's dirty but not owned, not co-owned, not in baseline external.
    // P1 lazy reclassification: it should appear in getExternalFiles.
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    // owned: none registered, so src/new-session-file.ts is unclassified
    const result = ownership.getExternalFiles(['src/new-session-file.ts'])
    // baseline externals + dynamic external
    assert.ok(result.includes('src/external-dirty.ts'))
    assert.ok(result.includes('temp.log'))
    assert.ok(result.includes('src/new-session-file.ts'))
  })

  it('getExternalFiles(currentDirtyFiles) does NOT reclassify owned files as external', () => {
    // Owned files should stay owned, not leak into external set
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/my-file.ts')
    const result = ownership.getExternalFiles(['src/my-file.ts'])
    // src/my-file.ts is owned → NOT in external
    assert.ok(!result.includes('src/my-file.ts'))
  })

  it('getExternalFiles(currentDirtyFiles) does NOT reclassify co-owned files as dynamic external', () => {
    // Co-owned files (external registered via registerOwned) appear in result from baseline,
    // but NOT from dynamic reclassification — the coOwnedSet guard prevents double-counting.
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    ownership.registerOwned('src/external-dirty.ts') // baseline external → co-owned
    const result = ownership.getExternalFiles(['src/external-dirty.ts'])
    // Still present via baseline external set, just not duplicated via dynamic path
    assert.ok(result.includes('src/external-dirty.ts'))
    // Verify no duplication
    assert.equal(result.filter(f => f === 'src/external-dirty.ts').length, 1)
  })

  it('getExternalFiles(currentDirtyFiles) with empty array returns baseline only', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const result = ownership.getExternalFiles([])
    assert.deepEqual(result, ['src/external-dirty.ts', 'temp.log'])
  })

  it('getExternalFiles(undefined) backward compatible — returns baseline only', () => {
    const baseline = createWorktreeBaseline(baselineSnap)
    const ledger = createTaskLedger({ taskId: 't1' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

    const result = ownership.getExternalFiles()
    assert.deepEqual(result, ['src/external-dirty.ts', 'temp.log'])
  })

  it('getExternalFiles(currentDirtyFiles) with mix of owned and unowned files', () => {
    const baseline = createWorktreeBaseline({
      branch: 'feat/b1',
      head: 'abc123',
      preExistingDirty: [],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 't1' })
    ledger.record({ type: 'file_write', path: 'src/owned.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()

    // src/owned.ts is owned, src/other-session.ts is unclassified
    const result = ownership.getExternalFiles(['src/owned.ts', 'src/other-session.ts'])
    assert.ok(!result.includes('src/owned.ts'), 'owned file must not leak into external')
    assert.ok(result.includes('src/other-session.ts'), 'unclassified file must be dynamic external')
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

  // ── autoOwnFromBaseline ledger trace guard ──

  it('does not auto-own dirty file without ledger trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    // ledger has NO events for 'src/new-from-other.ts'
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-from-other.ts'])
    assert.equal(ownership.isOwned('src/new-from-other.ts'), false)
  })

  it('auto-owns dirty file that has a ledger file_write trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'file_write', path: 'src/new-ours.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/new-ours.ts'])
    assert.equal(ownership.isOwned('src/new-ours.ts'), true)
  })

  it('auto-owns dirty file that has a ledger git_action trace', () => {
    const baseline = createWorktreeBaseline({
      branch: 'main',
      head: 'abc',
      preExistingDirty: ['src/old.ts'],
      preExistingUntracked: [],
      capturedAt: Date.now(),
    })
    const ledger = createTaskLedger({ taskId: 'test' })
    ledger.record({ type: 'git_action', path: 'src/staged.ts' })
    const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
    ownership.autoOwnFromLedger()
    ownership.autoOwnFromBaseline(['src/staged.ts'])
    assert.equal(ownership.isOwned('src/staged.ts'), true)
  })

  // ── adoptFiles — cross-session takeover ──

  describe('adoptFiles — cross-session takeover', () => {
    it('adopts external files into owned set', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: ['src/other-session-a.ts', 'src/other-session-b.ts'],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      // Before: these are external
      assert.equal(ownership.isOwned('src/other-session-a.ts'), false)
      assert.equal(ownership.isOwned('src/other-session-b.ts'), false)

      const adopted = ownership.adoptFiles(['src/other-session-a.ts', 'src/other-session-b.ts'])

      assert.deepEqual(adopted, ['src/other-session-a.ts', 'src/other-session-b.ts'])
      assert.equal(ownership.isOwned('src/other-session-a.ts'), true)
      assert.equal(ownership.isOwned('src/other-session-b.ts'), true)
      assert.deepEqual(ownership.getOwnedFiles(), ['src/other-session-a.ts', 'src/other-session-b.ts'])
    })

    it('returns only newly adopted files (skips already-owned)', () => {
      const baseline = createWorktreeBaseline({
        branch: 'main',
        head: 'abc',
        preExistingDirty: ['src/external.ts'],
        preExistingUntracked: [],
        capturedAt: Date.now(),
      })
      const ledger = createTaskLedger({ taskId: 'takeover' })
      ledger.record({ type: 'file_write', path: 'src/already-mine.ts' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
      ownership.autoOwnFromLedger()

      const adopted = ownership.adoptFiles(['src/external.ts', 'src/already-mine.ts'])

      // Only the external file was newly adopted
      assert.deepEqual(adopted, ['src/external.ts'])
      assert.equal(ownership.isOwned('src/external.ts'), true)
      assert.equal(ownership.isOwned('src/already-mine.ts'), true)
    })

    it('returns empty array when all files are already owned', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })
      ownership.registerOwned('src/mine.ts')

      const adopted = ownership.adoptFiles(['src/mine.ts'])

      assert.deepEqual(adopted, [])
    })

    it('returns empty array for empty input', () => {
      const baseline = createWorktreeBaseline(baselineSnap)
      const ledger = createTaskLedger({ taskId: 'takeover' })
      const ownership = createOwnershipLedger({ baseline, taskLedger: ledger })

      const adopted = ownership.adoptFiles([])

      assert.deepEqual(adopted, [])
    })
  })
})
