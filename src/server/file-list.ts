/**
 * Project file enumeration + ranking for the desktop @file mention picker.
 *
 * `listProjectFiles` walks a session's cwd applying the same gitignore + silent-
 * layer filters the glob tool uses, capped at MAX_FILES. `rankFiles` is a pure
 * function (unit-tested) that orders candidates by relevance to a query string.
 *
 * Security: the walk is rooted at the session cwd and never follows symlinks or
 * descends into build/VCS dirs; the route layer passes only `session.cwd`.
 */
import { readdir, lstat, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { relativePosix } from '../path-format.js'
import { GitignoreFilter } from '../tools/gitignore.js'
import { classifyPath } from '../context/attention-filter.js'

const EXCLUDE_DIRS = new Set([
  'node_modules', '.git', 'dist', '.next', 'build', 'target', '__pycache__',
])
const MAX_FILES = 2000

async function walk(
  dir: string,
  root: string,
  results: string[],
  gitignore: GitignoreFilter,
  visited: Set<string>,
): Promise<void> {
  if (results.length >= MAX_FILES) return

  let real: string
  try {
    real = await realpath(dir)
  } catch {
    return
  }
  if (visited.has(real)) return
  visited.add(real)

  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return
  }

  for (const name of names) {
    if (results.length >= MAX_FILES) return
    const fullPath = join(dir, name)
    let s: Awaited<ReturnType<typeof lstat>>
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }
    if (s.isSymbolicLink()) continue
    const rel = relativePosix(root, fullPath)
    const verdict = classifyPath(rel)
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      if (verdict.tier === 'L0_build') continue
      await walk(fullPath, root, results, gitignore, visited)
    } else if (s.isFile()) {
      if (verdict.silent) continue
      if (gitignore.isIgnored(root, fullPath)) continue
      results.push(rel)
    }
  }
}

/** Enumerate project files under cwd (gitignore + silent-layer filtered). */
export async function listProjectFiles(cwd: string): Promise<string[]> {
  const gitignore = await GitignoreFilter.create(cwd)
  const results: string[] = []
  await walk(cwd, cwd, results, gitignore, new Set<string>())
  return results
}

function basename(p: string): string {
  const i = p.lastIndexOf('/')
  return i === -1 ? p : p.slice(i + 1)
}

/** True if all chars of `q` appear in `s` in order (fuzzy subsequence match). */
function isSubsequence(s: string, q: string): boolean {
  let i = 0
  for (let j = 0; j < s.length && i < q.length; j++) {
    if (s[j] === q[i]) i++
  }
  return i === q.length
}

/**
 * Rank file paths by relevance to `query` and return the top `limit`.
 * Pure + deterministic — unit-tested. Empty query returns the shallowest paths.
 */
export function rankFiles(paths: string[], query: string, limit = 50): string[] {
  const q = query.trim().toLowerCase()
  if (!q) {
    return [...paths]
      .sort((a, b) => depth(a) - depth(b) || a.length - b.length || a.localeCompare(b))
      .slice(0, limit)
  }

  const scored: Array<{ path: string; score: number }> = []
  for (const path of paths) {
    const lower = path.toLowerCase()
    const base = basename(lower)
    let score: number
    if (base === q) score = 0
    else if (base.startsWith(q)) score = 1
    else if (base.includes(q)) score = 2
    else if (lower.includes(q)) score = 3
    else if (isSubsequence(lower, q)) score = 4
    else continue
    scored.push({ path, score })
  }

  scored.sort((a, b) =>
    a.score - b.score ||
    a.path.length - b.path.length ||
    a.path.localeCompare(b.path),
  )
  return scored.slice(0, limit).map((s) => s.path)
}

// ── Single-level directory listing (for file browser tree) ──────

export interface DirEntry {
  name: string
  isDirectory: boolean
}

/**
 * List direct children of `dir` — one level only (not recursive).
 * Used by the desktop file browser to lazily build a tree on expand.
 * Excludes common build/dependency directories and gitignored entries.
 * Directories sorted first, then files, both alphabetical.
 * Returns [] for non-existent or unreadable directories.
 */
export async function listDirEntries(dir: string): Promise<DirEntry[]> {
  let names: string[]
  try {
    names = await readdir(dir)
  } catch {
    return []
  }
  const gitignore = await GitignoreFilter.create(dir)
  const entries: DirEntry[] = []
  for (const name of names) {
    // Exclude hidden dirs like .git, .rivet — but allow dotfiles (.env.example)
    if (name.startsWith('.') && EXCLUDE_DIRS.has(name)) continue
    const fullPath = join(dir, name)
    let s: Awaited<ReturnType<typeof lstat>>
    try {
      s = await lstat(fullPath)
    } catch {
      continue
    }
    if (s.isSymbolicLink()) continue
    if (s.isDirectory()) {
      if (EXCLUDE_DIRS.has(name)) continue
      entries.push({ name, isDirectory: true })
    } else if (s.isFile()) {
      if (gitignore.isIgnored(dir, fullPath)) continue
      entries.push({ name, isDirectory: false })
    }
  }
  entries.sort((a, b) => {
    if (a.isDirectory !== b.isDirectory) return a.isDirectory ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return entries
}

function depth(p: string): number {
  let n = 0
  for (let i = 0; i < p.length; i++) if (p[i] === '/') n++
  return n
}
