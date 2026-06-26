import { copyFileSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { randomUUID } from 'node:crypto'

export interface ForkOptions {
  sourceJsonlPath: string
  targetDir: string
  /** If provided, copy only the first N lines of the source JSONL. */
  upToLine?: number
  /** Parent session ID — written to the new session's meta.json for branch tracking. */
  parentSessionId?: string
  /** Human-readable branch name — written to meta.json alongside parentSessionId. */
  branchName?: string
}

export interface ForkResult {
  newSessionId: string
  newJsonlPath: string
}

export interface BranchInfo {
  sessionId: string
  branchName: string | null
  parentSessionId: string
}

/**
 * Fork a session by copying its JSONL transcript to a new session ID.
 *
 * When `parentSessionId` is provided, also writes a minimal `.meta.json` for
 * the new session with `parentSessionId` and `branchName` fields, enabling
 * branch-tree navigation via `listBranches`.
 */
export function forkSession(options: ForkOptions): ForkResult {
  const newSessionId = randomUUID()
  const newJsonlPath = join(options.targetDir, `${newSessionId}.jsonl`)

  if (options.upToLine === undefined) {
    copyFileSync(options.sourceJsonlPath, newJsonlPath)
  } else {
    const lines = readFileSync(options.sourceJsonlPath, 'utf-8').trim().split('\n')
    writeFileSync(newJsonlPath, lines.slice(0, options.upToLine).join('\n') + '\n')
  }

  // Write metadata for branch tracking when parentSessionId is provided.
  if (options.parentSessionId) {
    const metaPath = join(options.targetDir, `${newSessionId}.meta.json`)
    const meta: Record<string, unknown> = {
      sessionId: newSessionId,
      parentSessionId: options.parentSessionId,
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    if (options.branchName) {
      meta.branchName = options.branchName
    }
    writeFileSync(metaPath, JSON.stringify(meta, null, 2) + '\n')
  }

  return { newSessionId, newJsonlPath }
}

/**
 * Count non-empty lines in a JSONL file. Used to determine the current
 * message count for `fork at <N>` validation.
 */
export function countMessageLines(jsonlPath: string): number {
  if (!existsSync(jsonlPath)) return 0
  const content = readFileSync(jsonlPath, 'utf-8')
  return content.trim().split('\n').filter(l => l.length > 0).length
}

/**
 * Find all direct child sessions (branches) of a given parent session.
 * Scans all `.meta.json` files in `sessionDir` for matching `parentSessionId`.
 */
export function listBranches(sessionDir: string, parentSessionId: string): BranchInfo[] {
  if (!existsSync(sessionDir)) return []

  const results: BranchInfo[] = []
  const files = readdirSync(sessionDir)

  for (const file of files) {
    if (!file.endsWith('.meta.json')) continue
    const metaPath = join(sessionDir, file)
    try {
      const meta = JSON.parse(readFileSync(metaPath, 'utf-8'))
      if (meta.parentSessionId === parentSessionId) {
        const sessionId = file.replace('.meta.json', '')
        results.push({
          sessionId,
          branchName: meta.branchName ?? null,
          parentSessionId,
        })
      }
    } catch {
      // Skip corrupted meta files
    }
  }

  return results
}
