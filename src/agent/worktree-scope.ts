import { spawnGitSync } from '../tools/spawn-git.js'
import { appendFileSync, copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

export interface ScopeMaterializeResult {
  /** Relative file paths copied from the base repo into the worker worktree. */
  materialized: string[]
  /** Original scope entries that are outside the repo or missing from both trees. */
  missing: string[]
}

function normalizeScopePath(baseCwd: string, filePath: string): string | null {
  if (!isAbsolute(filePath)) return filePath
  const rel = relative(baseCwd, filePath)
  if (rel === '' || rel.startsWith('..')) return null
  return rel
}

function workerGitPath(workerCwd: string, gitPath: string): string | null {
  const result = spawnGitSync(['rev-parse', '--git-path', gitPath], {
    cwd: workerCwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const resolved = result.stdout.trim()
  if (!resolved) return null
  return isAbsolute(resolved) ? resolved : resolve(workerCwd, resolved)
}

/**
 * Append the materialized path to the worker's git exclude — but ONLY when the
 * worker owns a private exclude file. For a linked worktree (VSW snapshots,
 * worktree-based hands workers) `git rev-parse --git-path info/exclude`
 * resolves to the MAIN repo's shared `.git/info/exclude`; appending there
 * poisons the base repo: the excluded source files vanish from `git status`,
 * the delivery gate demotes them to "historical owned", and `git commit`
 * rejects them as ignored (session 4df36bcd postmortem). Skipping the append
 * for shared excludes is the lesser evil — the worker's status shows the
 * materialized files as untracked, which downstream junk-filtering tolerates.
 */
function excludeFromWorkerDiff(workerCwd: string, relPath: string): void {
  const gitDir = gitRevParse(workerCwd, '--git-dir')
  const commonDir = gitRevParse(workerCwd, '--git-common-dir')
  // Linked worktree: git-dir (.git/worktrees/<id>) differs from common dir
  // (.git) and info/exclude lives in the SHARED common dir. Never write there.
  if (!gitDir || !commonDir || resolve(gitDir) !== resolve(commonDir)) return
  const excludePath = workerGitPath(workerCwd, 'info/exclude')
  if (!excludePath) return
  mkdirSync(dirname(excludePath), { recursive: true })
  appendFileSync(excludePath, `\n/${relPath}\n`)
}

function gitRevParse(workerCwd: string, flag: '--git-dir' | '--git-common-dir'): string | null {
  const result = spawnGitSync(['rev-parse', flag], {
    cwd: workerCwd,
    encoding: 'utf-8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  if (result.status !== 0) return null
  const resolved = result.stdout.trim()
  if (!resolved) return null
  return isAbsolute(resolved) ? resolved : resolve(workerCwd, resolved)
}

/**
 * Ensure files explicitly scoped for a hands worker are visible in its isolated
 * worktree. Git worktrees only contain tracked HEAD files; untracked local plan
 * docs or scratch files must be copied in before the worker can read them.
 */
export function materializeScope(
  baseCwd: string,
  workerCwd: string,
  scopeFiles: string[],
): ScopeMaterializeResult {
  const materialized: string[] = []
  const missing: string[] = []

  for (const filePath of scopeFiles) {
    const relPath = normalizeScopePath(baseCwd, filePath)
    if (!relPath) {
      missing.push(filePath)
      continue
    }

    const workerPath = join(workerCwd, relPath)
    if (existsSync(workerPath)) continue

    const basePath = join(baseCwd, relPath)
    if (!existsSync(basePath)) {
      missing.push(filePath)
      continue
    }

    mkdirSync(dirname(workerPath), { recursive: true })
    copyFileSync(basePath, workerPath)
    excludeFromWorkerDiff(workerCwd, relPath)
    materialized.push(relPath)
  }

  return { materialized, missing }
}
