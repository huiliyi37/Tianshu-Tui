import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getPermissionDirs, setPermissionDirs } from '../manager.js'

describe('permission dirs (standing directory grants) config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-permdirs-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns empty lists when unset', () => {
    assert.deepEqual(getPermissionDirs(), { additionalReadDirs: [], additionalWriteDirs: [] })
  })

  it('persists both lists and round-trips through loadConfig', () => {
    const r = setPermissionDirs({
      additionalReadDirs: ['/tmp/read-a', 'F:\\'],
      additionalWriteDirs: ['~/projects'],
    })
    assert.deepEqual(r, {
      additionalReadDirs: ['/tmp/read-a', 'F:\\'],
      additionalWriteDirs: ['~/projects'],
    })
    const cfg = loadConfig()
    assert.deepEqual(cfg.agent.permissions.additionalReadDirs, ['/tmp/read-a', 'F:\\'])
    assert.deepEqual(cfg.agent.permissions.additionalWriteDirs, ['~/projects'])
    assert.deepEqual(getPermissionDirs(), r)
  })

  it('updating only one list leaves the other untouched', () => {
    setPermissionDirs({ additionalReadDirs: ['/a'], additionalWriteDirs: ['/w'] })
    const r = setPermissionDirs({ additionalReadDirs: ['/a', '/b'] })
    assert.deepEqual(r.additionalReadDirs, ['/a', '/b'])
    assert.deepEqual(r.additionalWriteDirs, ['/w'])
  })

  it('trims, drops empties, and deduplicates entries', () => {
    const r = setPermissionDirs({
      additionalReadDirs: ['  /a  ', '', '   ', '/a', '/b'],
    })
    assert.deepEqual(r.additionalReadDirs, ['/a', '/b'])
  })

  it('rejects non-array / non-string input', () => {
    assert.throws(() => setPermissionDirs({ additionalReadDirs: '/not-an-array' }), /must be an array of strings/)
    assert.throws(() => setPermissionDirs({ additionalWriteDirs: [42] }), /must be an array of strings/)
  })

  it('an empty array clears the list', () => {
    setPermissionDirs({ additionalReadDirs: ['/a'] })
    const r = setPermissionDirs({ additionalReadDirs: [] })
    assert.deepEqual(r.additionalReadDirs, [])
    assert.deepEqual(loadConfig().agent.permissions.additionalReadDirs, [])
  })
})
