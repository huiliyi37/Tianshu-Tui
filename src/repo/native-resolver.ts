import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Resolve a usable better-sqlite3 `Database` constructor.
 *
 * Two distinct runtimes:
 *
 *   1. Packaged sidecar (Tauri bundle): there is no full `node_modules`. We ship
 *      the pure-JS wrapper at `dist/node_modules/better-sqlite3` (staged by
 *      stage-runtime-deps.js) and the native binary at `dist/native/
 *      better_sqlite3.node` (packed by pack-native.js). The wrapper is loaded
 *      and bound to that binary via better-sqlite3's `nativeBinding` option.
 *
 *      ⚠ Loading the raw `.node` directly does NOT work: it exports the internal
 *      addon object ({ Database, Statement, ... } with C++ signatures), not the
 *      JS `Database` class whose `prepare()/pragma()/transaction()` the app uses.
 *      The wrapper is mandatory.
 *
 *      In this runtime sqlite is REQUIRED. If `native/better_sqlite3.node` is
 *      present but the wrapper can't load, that's a packaging bug — we throw
 *      (code `ESQLITE_BUNDLE_BROKEN`) rather than silently degrade to a no-op DB.
 *
 *   2. Dev / CLI (`node_modules` available): resolve the full package normally.
 *
 * @param moduleUrl — `import.meta.url` of the calling module.
 * @returns a `Database` constructor, or `null` only when better-sqlite3 is
 *          genuinely absent (dev without the dependency installed).
 */
export function resolveBetterSqlite3(moduleUrl: string): any | null {
  // Detect the packaged-sidecar layout: native/ dir adjacent to the bundle.
  let nativePath: string | null = null
  let selfPath: string | null = null
  try {
    selfPath = fileURLToPath(moduleUrl)
    const candidate = join(dirname(selfPath), 'native', 'better_sqlite3.node')
    if (existsSync(candidate)) nativePath = candidate
  } catch {
    // moduleUrl is not a file URL — treat as non-bundled.
  }

  // ── Path 1: packaged sidecar — wrapper bound to the packed .node ──
  if (nativePath && selfPath) {
    let RealDatabase: any
    try {
      const req = createRequire(selfPath)
      RealDatabase = req('better-sqlite3')
    } catch (err) {
      // native binary shipped but JS wrapper unresolvable → broken build.
      throw Object.assign(
        new Error(
          `[better-sqlite3] native binary present at ${nativePath} but the JS ` +
            `wrapper failed to resolve (${(err as Error)?.message ?? err}). This ` +
            `is a packaging bug — refusing to silently degrade to NullDatabase. ` +
            `Ensure stage-runtime-deps.js staged dist/node_modules/better-sqlite3.`,
        ),
        { code: 'ESQLITE_BUNDLE_BROKEN' },
      )
    }
    return bindNativeBinding(RealDatabase, nativePath)
  }

  // ── Path 2: dev / CLI — full package from node_modules ──
  try {
    const req = createRequire(moduleUrl)
    return req('better-sqlite3')
  } catch {
    // not installed
  }

  // ── Path 3: genuinely unavailable ──
  return null
}

/**
 * Wrap the real `Database` constructor so callers can keep doing
 * `new Database(path)` while we transparently inject the packed native binary.
 * Instances are produced by the real constructor, so prototype methods and
 * `instanceof` behave normally.
 */
function bindNativeBinding(RealDatabase: any, nativePath: string): any {
  function BoundDatabase(this: unknown, filename?: unknown, options?: Record<string, unknown>) {
    return new RealDatabase(filename, { nativeBinding: nativePath, ...(options ?? {}) })
  }
  BoundDatabase.prototype = RealDatabase.prototype
  return BoundDatabase
}
