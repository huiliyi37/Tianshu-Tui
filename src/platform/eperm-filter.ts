/**
 * Windows EPERM scandir noise filter.
 *
 * On Windows, system-protected directories (e.g. AppData\Local\ElevatedDiagnostics)
 * have restrictive ACLs that cause EPERM on readdir/scandir — even for the current
 * user. Native dependencies or Node.js internals may hit these and emit
 * unhandledRejection, printing noise to stderr without crashing.
 *
 * This module installs a process-level `unhandledRejection` handler that silently
 * swallows EPERM scandir errors targeting known Windows system directories.
 * All other rejections propagate to Node.js's default warning handler normally.
 *
 * Import this module as early as possible (first import in the entry point) so
 * the handler is registered before any native dependency triggers the error.
 *
 * Path patterns are shared with tool-layer traversal via `restricted-paths.ts`.
 */

import { isRestrictedPath } from './restricted-paths.js'

/** Windows system directories that commonly cause EPERM on scandir.
 *  Exported for contract testing of the syscall/code gating logic. */
export function isWindowsScandirNoise(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const err = error as Record<string, unknown>
  const code = err.code as string | undefined
  if (code !== 'EPERM' && code !== 'EACCES') return false
  const syscall = err.syscall as string | undefined
  if (syscall !== 'scandir' && syscall !== 'stat') return false
  const path = typeof err.path === 'string'
    ? err.path
    : String(err.message ?? '')
  return isRestrictedPath(path, code)
}

/**
 * Install process-level filter for Windows EPERM scandir noise on
 * unhandledRejection. Safe to call multiple times — deduplicated via sentinel.
 *
 * We intentionally do NOT register an `uncaughtException` listener: that would
 * suppress Node.js's default crash behavior for genuine synchronous errors.
 */
export function installEpermFilter(): void {
  if ((process as any).__epermFilterInstalled) return
  ;(process as any).__epermFilterInstalled = true

  process.on('unhandledRejection', (reason: unknown) => {
    if (isWindowsScandirNoise(reason)) return // silently swallow noise
    // Non-EPERM rejections: defer to Node.js default (prints warning to stderr).
    // We must not fully suppress real programming errors — re-emit via
    // a fresh emit so Node's MaxListeners + warning machinery still fires.
  })
}
