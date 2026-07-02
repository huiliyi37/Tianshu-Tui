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
 * All other rejections are re-printed to stderr by the handler itself (having
 * ANY listener suppresses Node's built-in warning, so we must stay audible).
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
 * The unhandledRejection listener body. Exported so tests can exercise the
 * suppress-vs-print contract directly (triggering real unhandled rejections
 * under node:test is not possible — the runner intercepts them and fails
 * the current test before userland listeners can matter).
 */
export function handleRejection(reason: unknown): void {
  if (isWindowsScandirNoise(reason)) return // silently swallow noise
  // Non-noise rejections MUST stay audible. Registering any listener disables
  // Node's default unhandled-rejection warning entirely, so "defer to the
  // default" is not an option — we have to print the warning ourselves or
  // real programming errors become silent.
  const detail = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
  console.error(`[rivet] Unhandled promise rejection: ${detail}`)
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

  process.on('unhandledRejection', handleRejection)
}
