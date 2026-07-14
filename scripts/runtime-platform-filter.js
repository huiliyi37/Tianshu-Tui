/**
 * Filter foreign-arch optional platform packages when staging the sidecar
 * node_modules tree. Shared by stage-runtime-deps.js and its tests.
 */

/**
 * @param {string} name package name, e.g. @esbuild/darwin-x64 or @ast-grep/napi-darwin-arm64
 * @param {'arm64'|'x64'} keepArch
 * @returns {boolean} true if this package is for a different CPU arch and must not be staged
 */
export function isForeignPlatformPackage(name, keepArch) {
  /** @type {RegExpMatchArray | null} */
  let m =
    name.match(/^@esbuild\/(?:darwin|linux|win32|android|freebsd|netbsd|openbsd|sunos|aix)-(arm64|x64|ia32|arm)$/) ||
    name.match(/^@ast-grep\/napi-(?:darwin|linux|win32)-(arm64|x64)$/) ||
    name.match(/^napi-(?:darwin|linux|win32)-(arm64|x64)$/)
  if (!m) return false
  const raw = m[1]
  // Desktop ships only arm64/x64. Treat ia32/armv7 as always foreign.
  if (raw === 'ia32' || raw === 'arm') return true
  return raw !== keepArch
}
