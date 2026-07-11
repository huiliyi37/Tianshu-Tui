import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getShellConfig, setShellConfig } from '../manager.js'

describe('shell (Git Bash path) config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-shell-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getShellConfig returns empty strings when unset', () => {
    assert.deepEqual(getShellConfig(), { gitBashPath: '', gitPath: '' })
  })

  it('persists a custom Git Bash path and round-trips through loadConfig', () => {
    const r = setShellConfig({ gitBashPath: 'C:\\custom\\Git\\bin\\bash.exe' })
    assert.deepEqual(r, { gitBashPath: 'C:\\custom\\Git\\bin\\bash.exe', gitPath: '' })
    assert.equal(loadConfig().env.gitBashPath, 'C:\\custom\\Git\\bin\\bash.exe')
    assert.deepEqual(getShellConfig(), { gitBashPath: 'C:\\custom\\Git\\bin\\bash.exe', gitPath: '' })
  })

  it('persists a custom git path and round-trips through loadConfig', () => {
    const r = setShellConfig({ gitPath: 'D:\\tools\\Git\\cmd\\git.exe' })
    assert.deepEqual(r, { gitBashPath: '', gitPath: 'D:\\tools\\Git\\cmd\\git.exe' })
    assert.equal(loadConfig().env.gitPath, 'D:\\tools\\Git\\cmd\\git.exe')
    assert.deepEqual(getShellConfig(), { gitBashPath: '', gitPath: 'D:\\tools\\Git\\cmd\\git.exe' })
  })

  it('persists both paths at once', () => {
    const r = setShellConfig({
      gitBashPath: 'C:\\custom\\Git\\bin\\bash.exe',
      gitPath: 'D:\\tools\\Git\\cmd\\git.exe',
    })
    assert.deepEqual(r, {
      gitBashPath: 'C:\\custom\\Git\\bin\\bash.exe',
      gitPath: 'D:\\tools\\Git\\cmd\\git.exe',
    })
  })

  it('trims surrounding whitespace before persisting', () => {
    const r = setShellConfig({ gitBashPath: '  C:\\g\\bash.exe  ' })
    assert.equal(r.gitBashPath, 'C:\\g\\bash.exe')
  })

  it('an empty/whitespace value clears the override', () => {
    setShellConfig({ gitBashPath: 'C:\\g\\bash.exe' })
    const cleared = setShellConfig({ gitBashPath: '   ' })
    assert.deepEqual(cleared, { gitBashPath: '', gitPath: '' })
    assert.equal(loadConfig().env.gitBashPath, undefined)
  })

  it('an empty/whitespace gitPath clears the override', () => {
    setShellConfig({ gitPath: 'D:\\tools\\Git\\cmd\\git.exe' })
    const cleared = setShellConfig({ gitPath: '   ' })
    assert.deepEqual(cleared, { gitBashPath: '', gitPath: '' })
    assert.equal(loadConfig().env.gitPath, undefined)
  })
})
