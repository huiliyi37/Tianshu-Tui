import { statSync } from 'node:fs'
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

/** Safely read a file for prewarm cache, returning undefined if unsafe or too large. */
export function buildPrewarmValue(cwd: string, filePath: string): PrewarmValue | undefined {
  try {
    const payload = readFilePayload(cwd, { filePath })
    const stat = statSync(payload.canonicalPath)
    if (stat.size > MAX_PREWARM_BYTES) return undefined
    return {
      canonicalPath: payload.canonicalPath,
      content: payload.modelContent,
      uiContent: payload.uiContent,
    }
  } catch {
    return undefined
  }
}
