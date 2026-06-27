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

// ── file collection ───────────────────────────────────────────────

/** Directories to skip during recursive file collection. */
const EXCLUDE_DIRS = new Set(['node_modules', '.git', '.rivet'])

export function collectFiles(searchPath: string): string[] {
  const abs = resolve(searchPath)
  if (!existsSync(abs)) return []
  const stat = lstatSync(abs)
  if (stat.isFile()) return [abs]
  if (!stat.isDirectory()) return []
  const files: string[] = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        if (EXCLUDE_DIRS.has(entry.name)) continue
        walk(full)
      } else if (entry.isFile()) {
        files.push(full)
      }
    }
  }
  walk(abs)
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
