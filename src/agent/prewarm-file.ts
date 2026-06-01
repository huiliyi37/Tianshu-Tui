import { stat } from 'node:fs/promises'
import { existsSync, statSync } from 'node:fs'
import { readFilePayload } from '../tools/read-file.js'

const MAX_PREWARM_BYTES = 100_000

export interface PrewarmValue {
  canonicalPath: string
  content: string
  uiContent: string
}

/** Check if a read_file call can use prewarm cache (only full-file reads). */
export function canUsePrewarmForRead(input: Record<string, unknown>): boolean {
  return typeof input.file_path === 'string'
    && input.offset === undefined
    && input.limit === undefined
}

/** Safely read a file for prewarm cache (sync version for streaming callbacks). */
export function buildPrewarmValue(cwd: string, filePath: string): PrewarmValue | undefined {
  try {
    const payload = readFilePayload(cwd, { filePath })
    const fileStat = statSync(payload.canonicalPath)
    if (fileStat.size > MAX_PREWARM_BYTES) return undefined
    return {
      canonicalPath: payload.canonicalPath,
      content: payload.modelContent,
      uiContent: payload.uiContent,
    }
  } catch {
    return undefined
  }
}

/** Safely read a file for prewarm cache — ASYNC to avoid blocking the event loop. */
export async function buildPrewarmValueAsync(cwd: string, filePath: string): Promise<PrewarmValue | undefined> {
  try {
    // Use sync check for path safety, then async for heavy I/O
    const payload = readFilePayload(cwd, { filePath })
    const canonicalPath = payload.canonicalPath
    if (!existsSync(canonicalPath)) return undefined
    const fileStat = await stat(canonicalPath)
    if (fileStat.size > MAX_PREWARM_BYTES) return undefined
    // readFilePayload already did the sync read — reuse its result
    return {
      canonicalPath,
      content: payload.modelContent,
      uiContent: payload.uiContent,
    }
  } catch {
    return undefined
 
  }
}

/**
 * Batch prewarm recently-read files — yields to the event loop between
 * each file so the TUI stays responsive during turn boundary.
 */
export async function batchPrewarm(
  cwd: string,
  paths: string[],
  cache: import('./prewarm.js').PrewarmCache,
): Promise<void> {
  let count = 0
  for (const filePath of paths) {
    if (count >= 5) break
    const value = await buildPrewarmValueAsync(cwd, filePath)
    if (!value) continue
    if (cache.has(value.canonicalPath)) continue
    cache.set(value.canonicalPath, value)
    count++
    // Yield to event loop after each file so Ink can process input/render
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
