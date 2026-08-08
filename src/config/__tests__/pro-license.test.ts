import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, unlinkSync, mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { resolveProLicense, isProEnabled, isProFeatureEnabled } from '../pro-license.js'
import { DEFAULT_CONFIG } from '../default.js'
import type { Config } from '../schema.js'

const ALL_FEATURES_ON = { computerUse: true, chatGateway: true, teamMax: true, councilMultiRound: true, unattendedAutomation: true, spark: true }

function baseConfig(): Config {
  // Start from the real default and only mutate `pro` for the test.
  const cfg = structuredClone(DEFAULT_CONFIG) as Config
  cfg.pro = { enabled: false, features: { ...ALL_FEATURES_ON } }
  return cfg
}

describe('resolveProLicense — CLI 软 gate（无 RIVET_DESKTOP）', () => {
  const originalEnv = process.env.RIVET_PRO
  const originalDesktop = process.env.RIVET_DESKTOP
  let tmpLicense: string

  beforeEach(() => {
    delete process.env.RIVET_PRO
    delete process.env.RIVET_DESKTOP   // 默认测 CLI 软 gate（无 RIVET_DESKTOP）
    tmpLicense = join(mkdtempSync(join(tmpdir(), 'pro-license-')), 'pro.license')
  })

  afterEach(() => {
    if (originalEnv !== undefined) process.env.RIVET_PRO = originalEnv
    else delete process.env.RIVET_PRO
    if (originalDesktop !== undefined) process.env.RIVET_DESKTOP = originalDesktop
    else delete process.env.RIVET_DESKTOP
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

describe('resolveProLicense — 桌面端硬 gate（RIVET_DESKTOP=1）', () => {
  const originalPro = process.env.RIVET_PRO
  const originalDesktop = process.env.RIVET_DESKTOP
  let tmpLicense: string

  beforeEach(() => {
    process.env.RIVET_DESKTOP = '1'
    delete process.env.RIVET_PRO
    tmpLicense = join(mkdtempSync(join(tmpdir(), 'pro-desktop-')), 'pro.license')
  })

  afterEach(() => {
    if (originalPro !== undefined) process.env.RIVET_PRO = originalPro
    else delete process.env.RIVET_PRO
    if (originalDesktop !== undefined) process.env.RIVET_DESKTOP = originalDesktop
    else delete process.env.RIVET_DESKTOP
    try { unlinkSync(tmpLicense) } catch { /* ignore */ }
  })

  it('RIVET_PRO=1（Rust 验签后注入）→ enabled', () => {
    process.env.RIVET_PRO = '1'
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'env')
  })

  it('无 RIVET_PRO → disabled（Basic）', () => {
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false)
    assert.equal(info.source, 'none')
  })

  it('config.pro.enabled=true 后门被封死（硬 gate 安全核心）', () => {
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'stolen', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    // 即使用户手改 config.json 写 pro.enabled=true，无 RIVET_PRO 仍是 Basic——
    // Rust 端 Ed25519 验签是唯一解锁路径。
    assert.equal(info.enabled, false, 'config.pro.enabled 后门在桌面端必须失效')
    assert.equal(info.source, 'none')
  })

  it('pro.license 文件后门被封死', () => {
    writeFileSync(tmpLicense, 'fake-license-key')
    const info = resolveProLicense(baseConfig(), tmpLicense)
    assert.equal(info.enabled, false, 'pro.license 文件后门在桌面端必须失效')
    assert.equal(info.source, 'none')
  })

  it('config + file + RIVET_PRO=1 同时存在 → 只认 RIVET_PRO', () => {
    process.env.RIVET_PRO = '1'
    writeFileSync(tmpLicense, 'fake')
    const config = baseConfig()
    config.pro = { enabled: true, licenseKey: 'stolen', features: { ...ALL_FEATURES_ON } }
    const info = resolveProLicense(config, tmpLicense)
    assert.equal(info.enabled, true)
    assert.equal(info.source, 'env', '桌面端唯一可信源是 RIVET_PRO')
  })
})

describe('isProFeatureEnabled', () => {
  const originalEnv = process.env.RIVET_PRO
  const originalDesktop = process.env.RIVET_DESKTOP

  beforeEach(() => {
    delete process.env.RIVET_DESKTOP   // 测 CLI 软 gate 语义（config.enabled 可解锁）
  })

  afterEach(() => {
    if (originalEnv !== undefined) process.env.RIVET_PRO = originalEnv
    else delete process.env.RIVET_PRO
    if (originalDesktop !== undefined) process.env.RIVET_DESKTOP = originalDesktop
    else delete process.env.RIVET_DESKTOP
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
