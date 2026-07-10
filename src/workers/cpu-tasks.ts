/**
 * CPU-bound pure functions offloaded to a worker_threads pool.
 *
 * These are the single source of truth for diff computation — shared between
 * the worker thread (4s timeout) and the main-thread inline fallback (1s
 * timeout). The jsdiff functions are synchronous and O((N+M)·D); running them
 * in a worker keeps the TUI event loop alive during heavy rewrites.
 *
 * No side effects, no process/env — safe to run in any context.
 */

import { createTwoFilesPatch, structuredPatch, diffLines } from 'diff'

// ── Unified diff (for `buildFileDiff`) ──

export function diffUnifiedRaw(
  relPath: string,
  before: string,
  after: string,
  timeout: number,
): string | undefined {
  return createTwoFilesPatch(relPath, relPath, before, after, '', '', {
    context: 3,
    timeout,
  })
}

// ── Structured patch hunks (for `computeChangedLineRanges`) ──

export interface RawHunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: string[]
}

export function diffStructuredRaw(
  before: string,
  after: string,
  timeout: number,
): { hunks: RawHunk[] } | undefined {
  const patch = structuredPatch('a', 'a', before, after, '', '', {
    context: 0,
    timeout,
  })
  if (!patch) return undefined
  return { hunks: patch.hunks as RawHunk[] }
}

// ── Line-level diff (for `getDiffStats`) ──

export interface RawChange {
  added?: boolean
  removed?: boolean
  count?: number
}

export function diffLinesRaw(
  oldContent: string,
  newContent: string,
  timeout: number,
): RawChange[] | undefined {
  return diffLines(oldContent, newContent, { timeout }) as RawChange[] | undefined
}

// ── Session event-log parsing (reconnect replay) ──

/** Minimal structural shape of a persisted session event. Kept local so this
 *  module stays dependency-free (worker bundles it standalone). */
export interface RawSessionEvent {
  seq: number
  ts: number
  type: string
  data: Record<string, unknown>
}

/**
 * Parse an events.jsonl text into sorted events, dropping corrupt/partial
 * lines (crash mid-write). Single source of truth shared by the sync read
 * path and the worker-offloaded reconnect replay — JSON.parse over a large
 * log is exactly the kind of synchronous stretch that starves the sidecar
 * event loop (SSE pings included), so replays run it off-thread.
 */
export function parseEventsJsonlRaw(text: string): RawSessionEvent[] {
  const events: RawSessionEvent[] = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      const parsed = JSON.parse(trimmed) as RawSessionEvent
      if (parsed && typeof parsed.seq === 'number' && typeof parsed.type === 'string') {
        events.push(parsed)
      }
    } catch {
      // corrupt/partial line (e.g. crash mid-write) — drop it, keep the rest
    }
  }
  events.sort((a, b) => a.seq - b.seq)
  return events
}
