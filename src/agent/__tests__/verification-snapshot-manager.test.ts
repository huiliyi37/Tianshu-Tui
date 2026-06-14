import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import {
  createVerificationSnapshotManager,
  reapOrphanSnapshots,
} from '../verification-snapshot-manager.js'
import type { VerificationSnapshot } from '../verification-snapshot.js'

const tempDirs: string[] = []
function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'vsw-mgr-test-'))
  tempDirs.push(dir)
  return dir
}
afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* ignore */ }
  }
})

interface FakeSnapshot extends VerificationSnapshot {
  builds: number
  refreshes: number
  destroyed: boolean
}

function fakeSnapshotFactory(path: string) {
  const snap: FakeSnapshot = {
    path,
    baselineHead: 'head',
    builds: 1,
    refreshes: 0,
    destroyed: false,
    refresh() { this.refreshes++; return { appliedDiff: true, materialized: [], missing: [] } },
    destroy() { this.destroyed = true },
  }
  return snap
}

function baseInit(over: Partial<Parameters<typeof createVerificationSnapshotManager>[0]> = {}) {
  return {
    baseCwd: '/repo',
    sessionId: 'sess-1',
    baselineHead: 'abc123',
    isGitRepo: true,
    preExistingDirtyCount: 0,
    preExistingUntrackedCount: 0,
    sameCwdRunningSessions: () => 0,
    ...over,
  }
}

describe('VerificationSnapshotManager', () => {
  it('returns null (in-place) for a clean single session', () => {
    const mgr = createVerificationSnapshotManager(baseInit({
      createSnapshot: () => { throw new Error('should not build') },
      computeRef: () => 'ref',
    }))
    assert.equal(mgr.prepare(['src/a.ts']), null)
    assert.equal(mgr.lastDecision()?.mode, 'in-place')
    assert.equal(mgr.currentSnapshotRef(), undefined)
  })

  it('lazily builds a snapshot when baseline is dirty and reuses it when ref is unchanged', () => {
    let snap: FakeSnapshot | null = null
    const mgr = createVerificationSnapshotManager(baseInit({
      preExistingDirtyCount: 2,
      createSnapshot: (init) => { snap = fakeSnapshotFactory(join(init.baseCwd, '.rivet', 'vsw', init.sessionId)); return snap },
      computeRef: () => 'ref-stable',
    }))

    const p1 = mgr.prepare(['src/a.ts'])
    assert.ok(p1)
    assert.equal(p1!.snapshotRef, 'ref-stable')
    assert.equal(p1!.decision.mode, 'snapshot')
    assert.equal(snap!.builds, 1)

    // Same owned content → same ref → reuse, no rebuild.
    const p2 = mgr.prepare(['src/a.ts'])
    assert.ok(p2)
    assert.equal(snap!.builds, 1)
    assert.equal(snap!.refreshes, 0)
  })

  it('refreshes the snapshot when the owned diff (ref) changes', () => {
    let snap: FakeSnapshot | null = null
    let ref = 'ref-1'
    const mgr = createVerificationSnapshotManager(baseInit({
      sameCwdRunningSessions: () => 1,
      createSnapshot: (init) => { snap = fakeSnapshotFactory(init.baseCwd); return snap },
      computeRef: () => ref,
    }))
    mgr.prepare(['src/a.ts'])
    assert.equal(snap!.refreshes, 0)
    ref = 'ref-2'
    mgr.prepare(['src/a.ts', 'src/b.ts'])
    assert.equal(snap!.refreshes, 1)
    assert.equal(mgr.currentSnapshotRef(), 'ref-2')
  })

  it('destroy tears down the live snapshot', () => {
    let snap: FakeSnapshot | null = null
    const mgr = createVerificationSnapshotManager(baseInit({
      forceSnapshot: true,
      createSnapshot: (init) => { snap = fakeSnapshotFactory(init.baseCwd); return snap },
      computeRef: () => 'r',
    }))
    mgr.prepare(['src/a.ts'])
    mgr.destroy()
    assert.equal(snap!.destroyed, true)
    assert.equal(mgr.currentSnapshotRef(), undefined)
  })

  it('degrades to in-place (no build) when snapshot wanted but no baselineHead', () => {
    const mgr = createVerificationSnapshotManager(baseInit({
      baselineHead: undefined,
      preExistingDirtyCount: 5,
      createSnapshot: () => { throw new Error('should not build without baseline') },
      computeRef: () => 'r',
    }))
    assert.equal(mgr.prepare(['src/a.ts']), null)
    assert.equal(mgr.lastDecision()?.mode, 'in-place-degraded')
  })
})

describe('reapOrphanSnapshots', () => {
  function plantVsw(baseCwd: string, sessionId: string, pid: number): void {
    const dir = join(baseCwd, '.rivet', 'vsw', sessionId)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, '.vsw-owner.json'), JSON.stringify({ pid, sessionId }), 'utf-8')
  }

  it('reaps dirs whose owner pid is dead, keeps live ones and the current session', () => {
    const baseCwd = makeDir()
    plantVsw(baseCwd, 'dead', 111)
    plantVsw(baseCwd, 'alive', 222)
    plantVsw(baseCwd, 'me', 333)

    const removed: string[] = []
    const result = reapOrphanSnapshots({
      baseCwd,
      currentSessionId: 'me',
      isAlive: (pid) => pid === 222 || pid === 333,
      removeWorktreeDir: (_base, dir) => { removed.push(dir); rmSync(dir, { recursive: true, force: true }) },
    })

    assert.deepEqual(result.reaped, ['dead'])
    assert.ok(result.kept.includes('alive'))
    assert.ok(result.kept.includes('me'))
    assert.equal(existsSync(join(baseCwd, '.rivet', 'vsw', 'dead')), false)
    assert.equal(existsSync(join(baseCwd, '.rivet', 'vsw', 'alive')), true)
  })

  it('keeps dirs with no readable owner marker (fail safe)', () => {
    const baseCwd = makeDir()
    const dir = join(baseCwd, '.rivet', 'vsw', 'no-marker')
    mkdirSync(dir, { recursive: true })
    const result = reapOrphanSnapshots({ baseCwd, isAlive: () => false })
    assert.deepEqual(result.reaped, [])
    assert.deepEqual(result.kept, ['no-marker'])
  })

  it('returns empty when no vsw root exists', () => {
    const baseCwd = makeDir()
    const result = reapOrphanSnapshots({ baseCwd })
    assert.deepEqual(result.reaped, [])
    assert.deepEqual(result.kept, [])
  })
})
