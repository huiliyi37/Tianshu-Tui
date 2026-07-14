/**
 * After staging the full `typescript` package, drop weight that the sidecar
 * in-process typecheck fallback (`ts.createProgram`) never needs:
 * locale message packs, tsc/tsserver CLIs, typingsInstaller.
 *
 * We keep `typescript` in ROOTS — when a project has no node_modules/.bin/tsc,
 * lsp/client.ts falls back to require('typescript') from the staged tree.
 * Removing the package entirely would make that path fail-open (ranOk:false).
 */
import { existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

/** Locale / CLI / server files under typescript/lib that createProgram does not need. */
export const TS_LIB_DROP_FILES = new Set([
  '_tsc.js',
  '_tsserver.js',
  '_typingsInstaller.js',
  'tsserver.js',
  'tsserverlibrary.js',
  'tsserverlibrary.d.ts',
  'typingsInstaller.js',
  'watchGuard.js',
  'cancellationToken.js',
])

/**
 * @param {string} typescriptRoot staged package root (…/node_modules/typescript)
 * @returns {{ removed: string[] }}
 */
export function pruneTypescriptStaging(typescriptRoot) {
  /** @type {string[]} */
  const removed = []
  if (!existsSync(typescriptRoot)) return { removed }

  const lib = join(typescriptRoot, 'lib')
  if (existsSync(lib)) {
    for (const name of readdirSync(lib)) {
      const p = join(lib, name)
      const st = statSync(p)
      if (st.isDirectory()) {
        // Locale packs: cs, de, ja, zh-cn, …
        rmSync(p, { recursive: true, force: true })
        removed.push(`lib/${name}/`)
        continue
      }
      if (TS_LIB_DROP_FILES.has(name)) {
        rmSync(p, { force: true })
        removed.push(`lib/${name}`)
      }
    }
  }

  const bin = join(typescriptRoot, 'bin')
  if (existsSync(bin)) {
    rmSync(bin, { recursive: true, force: true })
    removed.push('bin/')
  }

  return { removed }
}
