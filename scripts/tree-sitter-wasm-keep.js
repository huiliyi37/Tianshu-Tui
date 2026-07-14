/**
 * Allowlist of tree-sitter grammar wasm files shipped in the packaged sidecar.
 *
 * Only languages loaded by `src/repo/meridian-parser.ts` (LANG_WASM) are kept.
 * Unsupported languages fall back to heuristic chunking; missing wasm would
 * only surface if meridian tried to parse them (it doesn't).
 */
import { existsSync, readdirSync, rmSync } from 'node:fs'
import { join } from 'node:path'

/** Filenames under tree-sitter-wasms/out/ that must remain after staging. */
export const TS_WASM_KEEP = new Set([
  'tree-sitter-typescript.wasm',
  'tree-sitter-python.wasm',
  'tree-sitter-go.wasm',
])

/**
 * Delete non-allowlisted .wasm files under `outDir`.
 * @param {string} outDir absolute path to tree-sitter-wasms/out
 * @returns {{ kept: string[], removed: string[] }}
 */
export function pruneTreeSitterWasms(outDir) {
  /** @type {string[]} */
  const kept = []
  /** @type {string[]} */
  const removed = []
  if (!existsSync(outDir)) return { kept, removed }
  for (const f of readdirSync(outDir)) {
    if (!f.endsWith('.wasm')) continue
    const p = join(outDir, f)
    if (TS_WASM_KEEP.has(f)) {
      kept.push(f)
    } else {
      rmSync(p, { force: true })
      removed.push(f)
    }
  }
  return { kept, removed }
}
