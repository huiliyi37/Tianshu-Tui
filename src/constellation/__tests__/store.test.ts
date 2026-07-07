import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  loadConstellation,
  appendMilestone,
  appendArchitectureShift,
  initConstellation,
  diffSkeleton,
  constellationPath,
  archivePath,
} from '../store.js'
import { createConstellation, emptySkeleton, MILESTONE_CAP, type Milestone, type Skeleton } from '../schema.js'

function tmp(): string {
  return mkdtempSync(join(tmpdir(), 'constellation-'))
}

function milestone(id: string, ts = 1): Milestone {
  return {
    id,
    timestamp: ts,
    sessionId: 's',
    agentMark: { numericId: 1, symbol: '✦', domain: '' },
    domain: '',
    summary: `m-${id}`,
    filesChanged: ['a.ts'],
    type: 'feature',
    verificationStatus: 'verified',
    cycleClose: 'cc',
    tags: [],
  }
}

test('appendMilestone auto-creates, persists, and round-trips', () => {
  const cwd = tmp()
  try {
    appendMilestone(cwd, milestone('m1'), 1000)
    assert.ok(existsSync(constellationPath(cwd)))
    const loaded = loadConstellation(cwd)
    assert.ok(loaded)
    assert.equal(loaded!.milestones.length, 1)
    assert.equal(loaded!.milestones[0]!.id, 'm1')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('appendMilestone is idempotent by id', () => {
  const cwd = tmp()
  try {
    appendMilestone(cwd, milestone('dup'), 1)
    appendMilestone(cwd, milestone('dup'), 2)
    const loaded = loadConstellation(cwd)
    assert.equal(loaded!.milestones.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('appendMilestone archives overflow beyond MILESTONE_CAP', () => {
  const cwd = tmp()
  try {
    for (let i = 0; i < MILESTONE_CAP + 5; i++) {
      appendMilestone(cwd, milestone(`m${i}`, i), i)
    }
    const loaded = loadConstellation(cwd)
    assert.equal(loaded!.milestones.length, MILESTONE_CAP)
    // oldest 5 rolled to archive
    assert.equal(loaded!.milestones[0]!.id, 'm5')
    assert.ok(existsSync(archivePath(cwd)))
    const archived = readFileSync(archivePath(cwd), 'utf-8').trim().split('\n')
    assert.equal(archived.length, 5)
    assert.equal((JSON.parse(archived[0]!) as Milestone).id, 'm0')
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('diffSkeleton reports added/removed modules and entry points', () => {
  const prev: Skeleton = { modules: [{ path: 'src/a' }], entryPoints: ['src/main.ts'], keyAbstractions: [], techStack: [] }
  const next: Skeleton = { modules: [{ path: 'src/a' }, { path: 'src/b' }], entryPoints: [], keyAbstractions: [], techStack: [] }
  const d = diffSkeleton(prev, next)
  assert.deepEqual(d.addedModules, ['src/b'])
  assert.deepEqual(d.removedModules, [])
  assert.deepEqual(d.removedEntryPoints, ['src/main.ts'])
  assert.equal(d.changed, true)
})

test('initConstellation records an architecture shift when skeleton changes', () => {
  const cwd = tmp()
  try {
    initConstellation(cwd, { skeleton: { modules: [{ path: 'src/a' }], entryPoints: [], keyAbstractions: [], techStack: [] } }, 1)
    initConstellation(cwd, { skeleton: { modules: [{ path: 'src/a' }, { path: 'src/b' }], entryPoints: [], keyAbstractions: [], techStack: [] }, shiftSummary: 'added b' }, 2)
    const loaded = loadConstellation(cwd)
    assert.equal(loaded!.architectureShifts.length, 1)
    assert.equal(loaded!.architectureShifts[0]!.summary, 'added b')
    assert.deepEqual(loaded!.architectureShifts[0]!.addedModules, ['src/b'])
    assert.equal(loaded!.skeleton.modules.length, 2)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('initConstellation with identical skeleton records no shift', () => {
  const cwd = tmp()
  try {
    const sk: Skeleton = { modules: [{ path: 'src/a' }], entryPoints: [], keyAbstractions: [], techStack: [] }
    initConstellation(cwd, { skeleton: sk }, 1)
    initConstellation(cwd, { skeleton: { ...sk, modules: [{ path: 'src/a' }] } }, 2)
    const loaded = loadConstellation(cwd)
    assert.equal(loaded!.architectureShifts.length, 0)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('loadConstellation returns null on missing or corrupt file', () => {
  const cwd = tmp()
  try {
    assert.equal(loadConstellation(cwd), null)
    appendArchitectureShift(cwd, {
      id: 's1', timestamp: 1, sessionId: '', summary: 'x',
      addedModules: [], removedModules: [], addedEntryPoints: [], removedEntryPoints: [],
    }, 1)
    const loaded = loadConstellation(cwd)
    assert.equal(loaded!.architectureShifts.length, 1)
  } finally {
    rmSync(cwd, { recursive: true, force: true })
  }
})

test('createConstellation + emptySkeleton are inert helpers', () => {
  const c = createConstellation({ projectId: 'x', name: 'x' })
  assert.deepEqual(c.skeleton, emptySkeleton())
})
