import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, getEditorConfig, setEditorConfig, getApprovalConfig, setApprovalConfig } from '../manager.js'

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

// ── Approval mode (授权档位) ──

describe('approval mode config', () => {
  let dir = ''

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'rivet-approval-config-'))
    process.env.RIVET_CONFIG_PATH = join(dir, 'config.json')
  })

  afterEach(() => {
    delete process.env.RIVET_CONFIG_PATH
    rmSync(dir, { recursive: true, force: true })
  })

  it('snapshot matches the loaded agent.approval (defaults are environment-dependent)', () => {
    assert.deepEqual(getApprovalConfig(), { approval: loadConfig().agent.approval })
  })

  it('persists a valid approval mode and reads it back', () => {
    const a = setApprovalConfig({ approval: 'dangerously-skip-permissions' })
    assert.deepEqual(a, { approval: 'dangerously-skip-permissions' })
    assert.deepEqual(loadConfig().agent.approval, 'dangerously-skip-permissions')
    // Back to a safe mode — the settings UI must be able to dial it down.
    setApprovalConfig({ approval: 'auto-safe' })
    assert.deepEqual(getApprovalConfig(), { approval: 'auto-safe' })
  })

  it('rejects an invalid approval value (nothing persisted)', () => {
    const before = loadConfig().agent.approval
    assert.throws(() => setApprovalConfig({ approval: 'everything' }))
    assert.equal(loadConfig().agent.approval, before)
  })
})
