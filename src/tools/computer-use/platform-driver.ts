/**
 * Platform driver selection for computer_use — shared by the tool itself and
 * the sidecar config route (permission probe), so "which driver runs on this
 * host" is decided in exactly one place.
 */

import { createMacosDriver, type ComputerUseDriver } from './macos-driver.js'
import { createWindowsDriver } from './windows-driver.js'

export function isComputerUsePlatform(platform: NodeJS.Platform): boolean {
  return platform === 'darwin' || platform === 'win32'
}

/** Build the native driver for a platform. Throws on unsupported hosts —
 *  callers gate on isComputerUsePlatform first. */
export function createPlatformDriver(platform: NodeJS.Platform = process.platform): ComputerUseDriver {
  if (platform === 'darwin') return createMacosDriver()
  if (platform === 'win32') return createWindowsDriver()
  throw new Error(`computer_use has no driver for platform "${platform}"`)
}
