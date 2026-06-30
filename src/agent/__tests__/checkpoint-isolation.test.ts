import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { rivetHome } from '../../config/paths.js'
import {
  checkpointFileForSession,
  loadCheckpointIndex,
  addToCheckpointIndex,
  removeFromCheckpointIndex,
} from '../checkpoint.js'

const RIVET_DIR = rivetHome()

function indexFileForCwd(cwd: string): string {
  const slug = cwd.replace(/[^a-zA-Z0-9]/g, '_').slice(-64)
  return join(RIVET_DIR, `checkpoint-index-${slug}.json`)
}

describe('checkpoint session isolation', () => {
  const cleanups: Array<() => void> = []

  afterEach(() => {
    for (const fn of cleanups.splice(0)) fn()
  })

  it('checkpointFileForSession returns session-scoped path', () => {
    const pathA = checkpointFileForSession('session-aaa')
    const pathB = checkpointFileForSession('session-bbb')
    assert.notEqual(pathA, pathB)
    assert.ok(pathA.includes('session-aaa'))
    assert.ok(pathB.includes('session-bbb'))
  })

  it('checkpoint index tracks multiple sessions for same cwd', () => {
    const cwd = '/repo/project-' + Date.now()
    const file = indexFileForCwd(cwd)
    cleanups.push(() => { if (existsSync(file)) rmSync(file) })

    addToCheckpointIndex(cwd, 'session-aaa', ['src/a.ts'])
    addToCheckpointIndex(cwd, 'session-bbb', ['src/b.ts'])

    const index = loadCheckpointIndex(cwd)
    assert.equal(index.length, 2)
    assert.ok(index.some(e => e.sessionId === 'session-aaa'))
    assert.ok(index.some(e => e.sessionId === 'session-bbb'))
  })

  it('removeFromCheckpointIndex removes only the target session', () => {
    const cwd = '/repo/remove-test-' + Date.now()
    const file = indexFileForCwd(cwd)
    cleanups.push(() => { if (existsSync(file)) rmSync(file) })

    addToCheckpointIndex(cwd, 'session-aaa', ['a.ts'])
    addToCheckpointIndex(cwd, 'session-bbb', ['b.ts'])
    removeFromCheckpointIndex(cwd, 'session-aaa')

    const index = loadCheckpointIndex(cwd)
    assert.equal(index.length, 1)
    assert.equal(index[0]!.sessionId, 'session-bbb')
  })

  it('addToCheckpointIndex updates existing entry instead of duplicating', () => {
    const cwd = '/repo/update-test-' + Date.now()
    const file = indexFileForCwd(cwd)
    cleanups.push(() => { if (existsSync(file)) rmSync(file) })

    addToCheckpointIndex(cwd, 'session-aaa', ['a.ts'])
    addToCheckpointIndex(cwd, 'session-aaa', ['a.ts', 'b.ts'])

    const index = loadCheckpointIndex(cwd)
    assert.equal(index.length, 1)
    assert.deepEqual(index[0]!.files, ['a.ts', 'b.ts'])
  })

  it('loadCheckpointIndex returns empty array for unknown cwd', () => {
    const cwd = '/repo/unknown-' + Date.now()
    const index = loadCheckpointIndex(cwd)
    assert.deepEqual(index, [])
  })
})
