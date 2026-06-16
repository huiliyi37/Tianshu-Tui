import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync } from 'node:fs'

/**
 * Resolve the better-sqlite3 native module.
 *
 * Try order:
 *   1. `native/better_sqlite3.node` adjacent to the caller's module URL
 *      (production / Tauri bundle — no `node_modules` available).
 *   2. `createRequire` from `node_modules` (dev mode / CLI).
 *   3. Return `null` — caller falls back to nullDb.
 *
 * @param moduleUrl — `import.meta.url` of the calling module.
 */
export function resolveBetterSqlite3(moduleUrl: string): any | null {
  // ── Path 1: bundled native/ directory ──
  try {
    const selfPath = fileURLToPath(moduleUrl)
    const dir = dirname(selfPath)
    const nativePath = join(dir, 'native', 'better_sqlite3.node')
    if (existsSync(nativePath)) {
      const nativeRequire = createRequire(nativePath + '/')
      return nativeRequire('./better_sqlite3.node')
    }
  } catch {
    // fall through to node_modules attempt
  }

  // ── Path 2: node_modules via createRequire ──
  try {
    const req = createRequire(moduleUrl)
    return req('better-sqlite3')
  } catch {
    // not installed
  }

  // ── Path 3: unavailable ──
  return null
}
