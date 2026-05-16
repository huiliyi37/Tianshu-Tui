import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { SessionPersist } from '../session-persist.js'

describe('SessionPersist', () => {
  let tempDir: string

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'rivet-test-'))
    process.env.RIVET_SESSION_DIR = tempDir
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
    delete process.env.RIVET_SESSION_DIR
  })

  it('creates a claim store for the session', () => {
    const persist = new SessionPersist('test-session-001')
    const store = persist.createClaimStore()
    assert.ok(store)
    assert.equal(typeof store.propose, 'function')
    assert.equal(typeof store.listActiveClaims, 'function')
  })

  it('buildMemoryBlock returns string for fresh session', () => {
    const persist = new SessionPersist('test-session-002')
    const block = persist.buildMemoryBlock()
    assert.equal(typeof block, 'string')
  })

  it('getSessionMemoryState returns undefined for fresh session', () => {
    const persist = new SessionPersist('test-session-003')
    const state = persist.getSessionMemoryState()
    assert.equal(state, undefined)
  })

  it('injectDurableClaims does not throw on fresh store', () => {
    const persist = new SessionPersist('test-session-004')
    const store = persist.createClaimStore()
    assert.doesNotThrow(() => persist.injectDurableClaims(store))
  })

  it('getBackupDir returns a path containing the session id', () => {
    const persist = new SessionPersist('test-session-005')
    const dir = persist.getBackupDir()
    assert.equal(typeof dir, 'string')
    assert.ok(dir.includes('test-session-005'))
  })
})
