import { stat } from 'node:fs/promises'
import { statSync } from 'node:fs'
import { readFilePayload } from '../tools/read-file.js'
import type { PrewarmCache } from './prewarm.js'

const MAX_PREWARM_BYTES = 100_000

export interface PrewarmValue {
  canonicalPath: string
  content: string
  uiContent: string
  /**
   * File mtime (ms) at prewarm time. The consumer re-stats the live file and
   * only serves the cached content when mtime still matches, so an external
   * edit between prewarm and the real read never serves stale content.
   */
  mtimeMs: number
  /**
   * stat().size at prewarm time — second staleness signal alongside mtime,
   * hardening against coarse-mtime filesystems (exFAT: 2s granularity) where
   * an edit inside the same timestamp window keeps mtime identical. Mirrors
   * ReadHistoryEntry.sizeBytes in read-file.ts.
   */
  sizeBytes: number
}

/** Check if a read_file call can use prewarm cache (only full-file reads). */
export function canUsePrewarmForRead(input: Record<string, unknown>): boolean {
  return typeof input.file_path === 'string'
    && input.offset === undefined
    && input.limit === undefined
}

/** Safely read a file for prewarm cache.
 *
 *  Stores the **full raw content** (no read cap applied), NOT the model-facing
 *  truncated/folded content. The read tool applies the active contextWindow's
 *  cap at consume time, so cap consistency is automatic regardless of which
 *  contextWindow was active when the file was prewarmed. Storing a cap-baked
 *  value here is what made the prewarm cache a dead store — a file prewarmed
 *  under a smaller cap would have served truncated content under a later larger
 *  cap (truncation regression). */
export async function buildPrewarmValue(cwd: string, filePath: string): Promise<PrewarmValue | undefined> {
  try {
    const payload = await readFilePayload(cwd, { filePath })
    const fileStat = await stat(payload.canonicalPath)
    if (fileStat.size > MAX_PREWARM_BYTES) return undefined
    return {
      canonicalPath: payload.canonicalPath,
      content: payload.rawContent,
      uiContent: payload.uiContent,
      mtimeMs: fileStat.mtimeMs,
      sizeBytes: fileStat.size,
    }
  } catch {
    return undefined
  }
}

/** Alias for batch callers that already use async. */
export const buildPrewarmValueAsync = buildPrewarmValue

/**
 * Consume a prewarmed file: return its full raw content only when a cache entry
 * exists AND the live file's mtime still matches the prewarm-time mtime.
 *
 * Returns `null` on miss or staleness (external edit) — the caller then falls
 * back to a normal read. This is the consumer the prewarm cache was missing: it
 * is the first `PrewarmCache.get()` call site in non-test code. The returned
 * content is the **full file** with no read cap; the read tool applies the
 * active contextWindow's cap, so cap consistency holds regardless of which cap
 * was in effect when the file was prewarmed.
 *
 * mtime is re-checked synchronously here (not at prewarm time) because prewarm
 * is fire-and-forget — a stat taken then could be stale by the time the real
 * read happens.
 */
export function consumePrewarm(cache: PrewarmCache, canonicalPath: string): PrewarmValue | null {
  const value = cache.get(canonicalPath)
  if (!value) return null
  try {
    const live = statSync(canonicalPath)
    if (live.mtimeMs !== value.mtimeMs || live.size !== value.sizeBytes) {
      cache.invalidate(canonicalPath)
      return null // file changed externally since prewarm (mtime OR size moved)
    }
    return value
  } catch {
    cache.invalidate(canonicalPath)
    return null // file deleted or unreadable
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
    await new Promise<void>(resolve => setImmediate(resolve))
  }
}
