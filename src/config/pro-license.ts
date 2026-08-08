import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './schema.js'

export type ProFeature = 'computerUse' | 'chatGateway' | 'teamMax' | 'councilMultiRound' | 'unattendedAutomation' | 'spark'

export interface ProLicenseInfo {
  enabled: boolean
  source: 'config' | 'env' | 'license-file' | 'none'
  licenseKey?: string
}

function defaultLicensePath(): string {
  return join(homedir(), '.rivet', 'pro.license')
}

/**
 * Resolve whether the current installation is running as Pro.
 *
 * Two regimes keyed by `RIVET_DESKTOP` (注入自桌面端 Tauri，CLI 无此变量):
 *
 * **桌面端（RIVET_DESKTOP=1，硬 gate）**: 只认 `RIVET_PRO === '1'`——它由
 * Rust 端 `activation.rs` Ed25519 验签后注入，Basic 时 `env_remove`，是可信
 * 单一来源。config.pro.enabled / pro.license 文件两条路径被显式封死，防止
 * Basic 用户改 config.json 一行即绕过 Rust 验签白嫖 Pro。
 *
 * **CLI（无 RIVET_DESKTOP，软 gate）**: 保留三路径（config > env > file），
 * 不验签——开源版有意放开，会编译会改配置的人不是付费群体。
 *
 * The license key itself is not cryptographically verified in this module;
 * desktop relies on Rust-side Ed25519 verification, CLI intentionally does not.
 */
export function resolveProLicense(
  config: Config,
  licensePath = defaultLicensePath()
): ProLicenseInfo {
  // 桌面端硬 gate：Rust 注入 RIVET_DESKTOP 标记 → 只认 RIVET_PRO（同样由 Rust
  // 验签后注入），封 config/file 后门。
  if (process.env.RIVET_DESKTOP === '1') {
    return process.env.RIVET_PRO === '1'
      ? { enabled: true, source: 'env' }
      : { enabled: false, source: 'none' }
  }
  // CLI 软 gate：三路径，有意不验签（开源版）。
  if (config.pro?.enabled) {
    return { enabled: true, source: 'config', licenseKey: config.pro.licenseKey }
  }
  if (process.env.RIVET_PRO === '1') {
    return { enabled: true, source: 'env' }
  }
  if (existsSync(licensePath)) {
    const key = readFileSync(licensePath, 'utf8').trim()
    if (key) {
      return { enabled: true, source: 'license-file', licenseKey: key }
    }
  }
  return { enabled: false, source: 'none' }
}

export function isProEnabled(config: Config): boolean {
  return resolveProLicense(config).enabled
}

/**
 * Check whether a specific Pro feature is enabled.
 *
 * A feature is enabled when:
 * - Pro is active, AND
 * - config.pro.features.<feature> is not explicitly set to false.
 *
 * Default for any feature under an active Pro license is true.
 */
export function isProFeatureEnabled(config: Config, feature: ProFeature): boolean {
  if (!isProEnabled(config)) return false
  return config.pro?.features?.[feature] !== false
}
