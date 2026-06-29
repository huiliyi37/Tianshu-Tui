import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getEditorConfig, setEditorConfig } from '../manager.js'

describe('editor (target-platform) config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-editor-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getEditorConfig returns schema defaults when nothing is configured', () => {
    assert.deepEqual(getEditorConfig(), { platform: 'auto', eol: 'auto' })
  })

  it('persists platform + eol and merges partial updates', () => {
    const a = setEditorConfig({ platform: 'windows' })
    assert.deepEqual(a, { platform: 'windows', eol: 'auto' })
    // Partial update keeps the previously-set platform.
    const b = setEditorConfig({ eol: 'lf' })
    assert.deepEqual(b, { platform: 'windows', eol: 'lf' })
    assert.deepEqual(loadConfig().editor, { platform: 'windows', eol: 'lf' })
  })

  it('rejects an invalid enum value (nothing persisted)', () => {
    assert.throws(() => setEditorConfig({ platform: 'solaris' }))
    assert.deepEqual(loadConfig().editor, { platform: 'auto', eol: 'auto' })
  })
})
