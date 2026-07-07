import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getUiConfig, setUiConfig } from '../manager.js'

describe('ui (theme) config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-ui-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('getUiConfig returns empty defaults when nothing is configured', () => {
    assert.deepEqual(getUiConfig(), {})
  })

  it('persists default theme and merges partial updates', () => {
    const a = setUiConfig({ theme: 'ziwei' })
    assert.deepEqual(a, { theme: 'ziwei' })
    // Partial update keeps the previously-set theme.
    const b = setUiConfig({ theme: 'cobalt' })
    assert.deepEqual(b, { theme: 'cobalt' })
    assert.deepEqual(loadConfig().ui, { theme: 'cobalt' })
  })

  it('rejects an invalid theme name (nothing persisted)', () => {
    assert.throws(() => setUiConfig({ theme: 'neon-pink' }))
    assert.deepEqual(loadConfig().ui, {})
  })

  it('clears theme when set to undefined', () => {
    setUiConfig({ theme: 'claude' })
    assert.deepEqual(loadConfig().ui, { theme: 'claude' })
    const cleared = setUiConfig({ theme: undefined })
    assert.deepEqual(cleared, {})
    assert.deepEqual(loadConfig().ui, {})
  })
})
