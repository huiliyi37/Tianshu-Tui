import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'
import type { Config } from './schema.js'

export type ProFeature = 'computerUse' | 'chatGateway' | 'teamMax' | 'councilMultiRound' | 'unattendedAutomation'

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
 * Priority:
 * 1. config.pro.enabled = true
 * 2. RIVET_PRO=1 environment variable
 * 3. Presence of a non-empty ~/.rivet/pro.license file
 *
 * The license key itself is not cryptographically verified here; this module
 * only answers "is Pro configured/active". Online license-server validation,
 * seat management, and expiry checks belong to a separate licensing service.
 */
export function resolveProLicense(
  config: Config,
  licensePath = defaultLicensePath()
): ProLicenseInfo {
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
