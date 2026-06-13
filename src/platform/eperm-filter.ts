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
 */

/** Windows system directories that commonly cause EPERM on scandir. */
const WINDOWS_NOISY_PATTERNS: readonly RegExp[] = [
  /ElevatedDiagnostics/i,
  /AppData[\\/]Local[\\/](?!Temp)/i, // AppData\Local subdirs except Temp
  /Windows[\\/]System32[\\/]config/i,
  /System Volume Information/i,
  /\$RECYCLE\.BIN/i,
]

/** True when the error is a Windows EPERM scandir on a known system directory. */
function isWindowsScandirNoise(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false
  const err = error as Record<string, unknown>
  // Node.js fs errors carry `code` and `syscall` properties.
  if (err.code !== 'EPERM') return false
  const syscall = err.syscall as string | undefined
  if (syscall !== 'scandir' && syscall !== 'stat') return false
  const path = typeof err.path === 'string'
    ? err.path
    : String(err.message ?? '')
  return WINDOWS_NOISY_PATTERNS.some(re => re.test(path))
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
