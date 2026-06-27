import { existsSync, readdirSync, lstatSync } from 'node:fs'
import { resolve, extname, join } from 'node:path'

// ── language inference ────────────────────────────────────────────

export const LANG_BY_EXT: Record<string, string> = {
  '.ts': 'TypeScript',
  '.tsx': 'Tsx',
  '.js': 'JavaScript',
  '.jsx': 'Tsx',
  '.html': 'Html',
  '.css': 'Css',
}

export function inferLang(filePath: string): string | null {
  const ext = extname(filePath).toLowerCase()
  return LANG_BY_EXT[ext] ?? null
}

export function resolveLang(explicit: string | undefined, filePath: string): string | null {
  if (explicit) return explicit
  return inferLang(filePath)
}

/**
 * Build the language-name → napi.Lang-value map. ast-grep/napi's `Lang` uses
 * non-enumerable getters, so this must be constructed AFTER the dynamic import
 * resolves. Shared by ast-grep and ast-edit to keep the supported-language list
 * in one place — the runtime assertion (typeof string) guards against napi API
 * changes that would silently turn these into undefined.
 */
export function buildLangMap(napi: typeof import('@ast-grep/napi')): Record<string, string> {
  return {
    TypeScript: napi.Lang.TypeScript as unknown as string,
    Tsx: napi.Lang.Tsx as unknown as string,
    JavaScript: napi.Lang.JavaScript as unknown as string,
    Html: napi.Lang.Html as unknown as string,
    Css: napi.Lang.Css as unknown as string,
  }
}

// ── file collection ───────────────────────────────────────────────

/** Directories to skip during recursive file collection.
 *  Build artifacts (dist/build/out/.next/coverage) are excluded so ast_grep
 *  doesn't parse compiled output — it produces noise matches and wastes parse
 *  budget on files that aren't the source of truth. */
const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', '.rivet',
  'dist', 'build', 'out', '.next', '.turbo', 'coverage', '.nyc_output',
])
/** Hard cap on files collected per ast_grep/ast_edit invocation. Without it,
 *  a bare `ast_grep pattern` (paths defaults to '.') parses every source file
 *  in the repo — readFileSync + tree-sitter parse on thousands of files stalls
 *  the tool and can OOM. 5000 covers any realistic targeted search; a search
 *  hitting the cap almost certainly forgot to scope `paths`. */
const MAX_FILES = 5000
/** Recursion depth cap — defends against pathological symlink loops even
 *  though Dirent.isDirectory() is already symlink-safe (lstatSync on the root
 *  only); nested real dirs this deep indicate a generated/ vendored tree. */
const MAX_DEPTH = 25

export function collectFiles(searchPath: string): string[] {
  const abs = resolve(searchPath)
  if (!existsSync(abs)) return []
  const stat = lstatSync(abs)
  if (stat.isFile()) return [abs]
  if (!stat.isDirectory()) return []
  const files: string[] = []
  const walk = (dir: string, depth: number): void => {
    if (files.length >= MAX_FILES || depth > MAX_DEPTH) return
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (files.length >= MAX_FILES) return
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        walk(full, depth + 1)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  walk(abs, 0)
  return files
}

// ── meta-variable parsing ─────────────────────────────────────────

/**
 * Extract meta-variable names from an ast-grep pattern string.
 * Returns pairs of (name, isMulti) where isMulti means $$$NAME (multi-node).
 */
export function collectMetaVarNames(pattern: string): Array<{ name: string; multi: boolean }> {
  const seen = new Set<string>()
  const vars: Array<{ name: string; multi: boolean }> = []
  // group 1: $$ (optional, present → multi), group 2: name
  // Source: pattern like "function $NAME($$$ARGS) { $$$BODY }"
  const re = /\$(\$\$)?([A-Za-z_][A-Za-z0-9_]*)/g
  let m: RegExpExecArray | null
  while ((m = re.exec(pattern)) !== null) {
    const name = m[2]!
    if (!seen.has(name)) {
      seen.add(name)
      vars.push({ name, multi: m[1] === '$$' })
    }
  }
  return vars
}
