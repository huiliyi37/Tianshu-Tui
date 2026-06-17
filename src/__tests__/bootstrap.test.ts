import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { cleanupStaleWorkerSessionDirs } from '../bootstrap.js'

describe('cleanupStaleWorkerSessionDirs', () => {
  let testCwd: string

  before(() => {
    testCwd = mkdtempSync(join(tmpdir(), 'rivet-worker-cleanup-'))
  })

  after(() => {
    rmSync(testCwd, { recursive: true, force: true })
  })

  it('removes stale worker dirs but keeps fresh ones and non-worker dirs', () => {
    const sessionsDir = join(testCwd, '.rivet', 'sessions')

    // Stale worker dir — backdate mtime to 2 hours ago
    const staleDir = join(sessionsDir, 'worker-old')
    mkdirSync(staleDir, { recursive: true })
    writeFileSync(join(staleDir, 'pheromones.json'), '{}')
    const twoHrsAgo = Date.now() / 1000 - 2 * 3600
    utimesSync(staleDir, twoHrsAgo, twoHrsAgo)

    // Fresh worker dir — just created, well within 1h threshold
    const freshDir = join(sessionsDir, 'worker-fresh')
    mkdirSync(freshDir, { recursive: true })
    writeFileSync(join(freshDir, 'pheromones.json'), '{}')

    // Non-worker dir — must never be touched regardless of age
    const mainDir = join(sessionsDir, 'main-session')
    mkdirSync(mainDir, { recursive: true })

    const cleaned = cleanupStaleWorkerSessionDirs(testCwd, 3_600_000)

    assert.equal(cleaned, 1)
    assert.ok(!existsSync(staleDir), 'stale worker dir should be removed')
    assert.ok(existsSync(freshDir), 'fresh worker dir should survive')
    assert.ok(existsSync(mainDir), 'non-worker dir must never be touched')
  })

  it('returns 0 when sessions dir does not exist', () => {
    const emptyCwd = mkdtempSync(join(tmpdir(), 'rivet-worker-empty-'))
    const cleaned = cleanupStaleWorkerSessionDirs(emptyCwd)
    assert.equal(cleaned, 0)
    rmSync(emptyCwd, { recursive: true, force: true })
  })
})
