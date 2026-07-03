/**
 * Shared restricted-path detection for filesystem permission noise.
 *
 * Used by both the `unhandledRejection` filter (`eperm-filter.ts`) and tool-layer
 * directory traversal (`grep.ts`, `ast-shared.ts`) to decide whether an EPERM/EACCES
 * error on a known system-protected directory should be silently suppressed.
 *
 * Fail-closed contract:
 * - `code` is required. Only EPERM / EACCES are treated as suppressible noise.
 *   Missing code or any other value (ENOENT, EIO, ...) → false.
 * - Path must match a known system directory pattern → false otherwise.
 *
 * Pattern anchoring discipline:
 * Every pattern uses `[\\/]` directory-segment boundaries to prevent bare-substring
 * false matches on user paths (e.g. `my-elevateddiagnostics-notes/`). The old
 * carpet pattern `AppData[\\/]Local[\\/](?!Temp)` is intentionally NOT used because
 * it matches `%LOCALAPPDATA%\.rivet` — the Rivet data directory on Windows (see
 * AGENTS.md "Windows 注意"). Only exact subdirectory names are listed.
 */

/** Windows system directories that commonly cause EPERM on scandir/stat. */
const WINDOWS_RESTRICTED_PATTERNS: readonly RegExp[] = [
  // Known ACL-restricted subdirs under AppData\Local — exact match only.
  // Source: Windows ACL-restricted directories observed in production telemetry.
  /AppData[\\/]Local[\\/]ElevatedDiagnostics([\\/]|$)/i,
  /AppData[\\/]Local[\\/]Packages([\\/]|$)/i,
  /AppData[\\/]Local[\\/]Microsoft[\\/]Windows[\\/]Notifications([\\/]|$)/i,
  /AppData[\\/]Local[\\/]Microsoft[\\/]Windows[\\/]INetCache([\\/]|$)/i,
  /AppData[\\/]Local[\\/]Microsoft[\\/]Windows[\\/]Temporary Internet Files([\\/]|$)/i,
  /AppData[\\/]Local[\\/]Microsoft[\\/]WindowsApps([\\/]|$)/i,
  /Windows[\\/]System32[\\/]config([\\/]|$)/i,
  /Windows[\\/]CSC([\\/]|$)/i,
  /(^|[\\/])System Volume Information([\\/]|$)/i,
  /(^|[\\/])\$Recycle\.?Bin([\\/]|$)/i, // matches $RECYCLE.BIN, $Recycle.Bin
  /(^|[\\/])Config\.Msi([\\/]|$)/i,
]

/** macOS system directories with restrictive ACLs (EPERM under SIP/TCC). */
const MACOS_RESTRICTED_PATTERNS: readonly RegExp[] = [
  /(^|\/)\.Spotlight-V100([\/]|$)/i,
  /(^|\/)\.fseventsd([\/]|$)/i,
  /(^|\/)\.TemporaryItems([\/]|$)/i,
  /(^|\/)\.DocumentRevisions-V100([\/]|$)/i,
  /(^|\/)\.Trashes([\/]|$)/i,
]

/** Linux system paths that commonly cause EACCES on readdir. */
const LINUX_RESTRICTED_PATTERNS: readonly RegExp[] = [
  /^\/proc\/\d+\/(fd|map_files|task\/\d+\/fd)([\/]|$)/,
  /^\/sys\/kernel\/debug([\/]|$)/,
  /^\/sys\/fs\/cgroup([\/]|$)/,
  /(^|\/)lost\+found([\/]|$)/,
]

const ALL_RESTRICTED: readonly RegExp[] = [
  ...WINDOWS_RESTRICTED_PATTERNS,
  ...MACOS_RESTRICTED_PATTERNS,
  ...LINUX_RESTRICTED_PATTERNS,
]

/**
 * Check if a filesystem permission error targets a known restricted/protected
 * system directory that should be silently skipped during directory traversal.
 *
 * @param path - Node.js fs error's `error.path` (preferred) or `error.message`.
 * @param code - `error.code`. Must be 'EPERM' or 'EACCES' for suppression.
 * @returns true if the error should be silently suppressed.
 */
export function isRestrictedPath(path: string, code: string): boolean {
  if (code !== 'EPERM' && code !== 'EACCES') return false
  if (!path) return false
  return ALL_RESTRICTED.some(re => re.test(path))
}
