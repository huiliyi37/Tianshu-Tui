import { stat } from 'node:fs/promises'
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

/** Safely read a file for prewarm cache. */
export async function buildPrewarmValue(cwd: string, filePath: string): Promise<PrewarmValue | undefined> {
  try {
    const payload = await readFilePayload(cwd, { filePath })
    const fileStat = await stat(payload.canonicalPath)
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

/** Alias for batch callers that already use async. */
export const buildPrewarmValueAsync = buildPrewarmValue

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
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
