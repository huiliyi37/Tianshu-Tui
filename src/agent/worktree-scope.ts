import { copyFileSync, existsSync, mkdirSync } from 'node:fs'
import { dirname, isAbsolute, join, relative } from 'node:path'

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
    materialized.push(relPath)
  }

  return { materialized, missing }
}
