import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, mkdirSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { loadConfig, loadConfigDefault, findProjectConfig } from '../manager.js'

describe('loadConfig — 3-layer resolution', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'rivet-config-test-'))

  it('returns valid config when no project/session config exists', () => {
    const config = loadConfig({ cwd: tempDir })
    assert.ok(config.provider)
    assert.ok(config.agent)
    // approval may be overridden by user's global config, just check it's valid
    assert.ok(['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions'].includes(config.agent.approval))
  })

  it('applies project config over defaults', () => {
    const projectDir = join(tempDir, 'my-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
      agent: { approval: 'manual', maxTurns: 10 },
    }))

    const config = loadConfig({ cwd: projectDir })
    assert.equal(config.agent.approval, 'manual')
    assert.equal(config.agent.maxTurns, 10)
    // Other defaults preserved
    assert.equal(config.agent.mode, 'code')

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('applies session overlay over project config', () => {
    const config = loadConfig({
      cwd: tempDir,
      sessionOverlay: {
        agent: { approval: 'auto-accept' },
      },
    })
    assert.equal(config.agent.approval, 'auto-accept')
  })

  it('applies Songline runtime opt-in from project config and session overlay', () => {
    const projectDir = join(tempDir, 'songline-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), JSON.stringify({
      agent: { songlineEnabled: true },
    }))

    const projectConfig = loadConfig({ cwd: projectDir })
    assert.equal(projectConfig.agent.songlineEnabled, true)

    const overlayConfig = loadConfig({
      cwd: projectDir,
      sessionOverlay: { agent: { songlineEnabled: false } },
    })
    assert.equal(overlayConfig.agent.songlineEnabled, false)

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('uses explicit projectConfigPath when provided', () => {
    const customConfigPath = join(tempDir, 'custom-config.json')
    writeFileSync(customConfigPath, JSON.stringify({
      agent: { approval: 'suggest' },
    }))

    const config = loadConfig({ projectConfigPath: customConfigPath })
    assert.equal(config.agent.approval, 'suggest')

    rmSync(customConfigPath, { force: true })
  })

  it('gracefully skips malformed project config', () => {
    const projectDir = join(tempDir, 'malformed-project')
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(join(projectDir, '.rivet-config.json'), 'not valid json {{{')

    const config = loadConfig({ cwd: projectDir })
    // Falls back to global/user config (not default 'auto-safe' if user has custom config)
    assert.ok(['auto-accept', 'auto-safe', 'suggest', 'manual', 'dangerously-skip-permissions'].includes(config.agent.approval))

    rmSync(projectDir, { recursive: true, force: true })
  })

  it('validates merged config through Zod schema', () => {
    const config = loadConfig({
      cwd: tempDir,
      sessionOverlay: {
        compact: { enabled: false },
      },
    })
    assert.equal(config.compact.enabled, false)
  })

  // Cleanup
  it('cleanup temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true })
    assert.ok(true)
  })
})

describe('findProjectConfig', () => {
  const tempDir = mkdtempSync(join(tmpdir(), 'rivet-find-config-'))

  it('returns undefined when no config file exists', () => {
    const result = findProjectConfig(tempDir)
    assert.equal(result, undefined)
  })

  it('finds config in current directory', () => {
    writeFileSync(join(tempDir, '.rivet-config.json'), '{}')
    const result = findProjectConfig(tempDir)
    assert.ok(result)
    assert.ok(result!.endsWith('.rivet-config.json'))
    rmSync(join(tempDir, '.rivet-config.json'), { force: true })
  })

  it('finds config in parent directory', () => {
    const childDir = join(tempDir, 'child', 'grandchild')
    mkdirSync(childDir, { recursive: true })
    writeFileSync(join(tempDir, '.rivet-config.json'), '{}')

    const result = findProjectConfig(childDir)
    assert.ok(result)
    assert.ok(result!.includes(tempDir))

    rmSync(join(tempDir, '.rivet-config.json'), { force: true })
    rmSync(join(tempDir, 'child'), { recursive: true, force: true })
  })

  it('stops before reaching filesystem root', () => {
    // Starting from root should not infinite loop
    const result = findProjectConfig('/')
    // Just verify it returns something (undefined or a path) without hanging
    assert.ok(result === undefined || typeof result === 'string')
  })

  // Cleanup
  it('cleanup temp dir', () => {
    rmSync(tempDir, { recursive: true, force: true })
    assert.ok(true)
  })
})

describe('loadConfigDefault', () => {
  it('returns valid config without options', () => {
    const config = loadConfigDefault()
    assert.ok(config.provider)
    assert.ok(config.agent)
    assert.equal(typeof config.provider.default, 'string')
  })
})
