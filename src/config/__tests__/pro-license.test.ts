import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProLicense, isProEnabled, isProFeatureEnabled } from '../pro-license.js'
import { DEFAULT_CONFIG } from '../default.js'
import type { Config } from '../schema.js'

const ALL_FEATURES_ON = { computerUse: true, chatGateway: true, teamMax: true, councilMultiRound: true, unattendedAutomation: true }

function baseConfig(): Config {
  // Start from the real default and only mutate `pro` for the test.
  const cfg = structuredClone(DEFAULT_CONFIG) as Config
  cfg.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
  return cfg
}

describe('resolveProLicense', () => {
  const originalEnv = process.env.RIVET_PRO
  let tmpLicense: string

  beforeEach(() => {
    delete process.env.RIVET_PRO
    tmpLicense = join(mkdtempSync(join(tmpdir(), 'pro-license-')), 'pro.license')
  })

  afterEach(() => {
    if (originalEnv !== undefined) process.env.RIVET_PRO = originalEnv
    else delete process.env.RIVET_PRO
    try { unlinkSync(tmpLicense) } catch { /* ignore */ }
  })

  it('returns enabled=true when config.pro.enabled is true', () => {
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'key-from-config', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'config')
    assert.equal(info.licenseKey, 'key-from-config')
  })

  it('returns enabled=true when RIVET_PRO=1', () => {
    process.env.RIVET_PRO = '1'
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'env')
  })

  it('returns enabled=true when a non-empty license file exists', () => {
    writeFileSync(tmpLicense, 'license-file-key\n')
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'license-file')
    assert.equal(info.licenseKey, 'license-file-key')
  })

  it('ignores empty license files', () => {
    writeFileSync(tmpLicense, '   \n')
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.source, 'none')
  })

  it('returns enabled=false when no Pro source is present', () => {
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.source, 'none')
  })

  it('config takes priority over env and license file', () => {
    process.env.RIVET_PRO = '1'
    writeFileSync(tmpLicense, 'file-key')
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'config-key', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.source, 'config')
    assert.equal(info.licenseKey, 'config-key')
  })
})

describe('isProFeatureEnabled', () => {
  const originalEnv = process.env.RIVET_PRO

  afterEach(() => {
    if (originalEnv !== undefined) process.env.RIVET_PRO = originalEnv
    else delete process.env.RIVET_PRO
  })

  it('returns false when Pro is disabled', () => {
    const config = baseConfig()
    config.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), false)
  })

  it('returns true when Pro is enabled and feature defaults to true', () => {
    const config = baseConfig()
    config.pro = { enabled: true, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), true)
    assert.equal(isProFeatureEnabled(config, 'chatGateway'), true)
  })

  it('returns false when Pro is enabled but feature is explicitly disabled', () => {
    const config = baseConfig()
    config.pro = { enabled: true, features: { ...ALL_FEATURES_ON, computerUse: false, chatGateway: false } }
    assert.equal(isProFeatureEnabled(config, 'computerUse'), false)
  })

  it('isProEnabled reflects RIVET_PRO=1', () => {
    process.env.RIVET_PRO = '1'
    assert.equal(isProEnabled(baseConfig()), true)
  })

  // ── 双层模式新增 Pro 功能位 ──

  it('teamMax / councilMultiRound default to enabled under an active Pro license', () => {
    const config = baseConfig()
    config.pro = { enabled: true, features: { ...ALL_FEATURES_ON } }
    assert.equal(isProFeatureEnabled(config, 'teamMax'), true)
    assert.equal(isProFeatureEnabled(config, 'councilMultiRound'), true)
  })

  it('teamMax / councilMultiRound are off without Pro', () => {
    const config = baseConfig()
    assert.equal(isProFeatureEnabled(config, 'teamMax'), false)
    assert.equal(isProFeatureEnabled(config, 'councilMultiRound'), false)
  })

  it('RIVET_PRO=1（桌面端 Rust 注入通道）启用全部新功能位', () => {
    process.env.RIVET_PRO = '1'
    const config = baseConfig()
    assert.equal(isProFeatureEnabled(config, 'teamMax'), true)
    assert.equal(isProFeatureEnabled(config, 'councilMultiRound'), true)
  })
})
