import { cpuPool } from '../workers/cpu-pool.js'
import { diffUnifiedRaw, diffStructuredRaw } from '../workers/cpu-tasks.js'
import type { RawHunk } from '../workers/cpu-tasks.js'

/**
 * Display-only unified diff for write-family tools (edit_file/write_file/…).
 *
 * The result is meant for the `uiContent` channel (TUI/desktop tool card),
 * never the model-facing `content` — so it must NOT enter conversation history
 * and has no prefix-cache cost. The TUI colors it via the existing
 * write-family + isDiffContent() branch in format/tool-card.ts.
 */

const DEFAULT_MAX_DIFF_LINES = 600

/**
 * Inline-fallback timeout for a single Myers diff pass (1s).
 *
 * jsdiff's Myers is O((N+M)·D) SYNCHRONOUS CPU — a full rewrite of an 8K-line
 * file costs ~7s per pass, and a 50K-line file with 1/3 changed runs for
 * MINUTES. That blocks the entire event loop: TUI frozen, Esc/stdin dead,
 * withToolTimeout's setTimeout can't fire (sync code is uninterruptible), so
 * the user force-kills the process and the already-written file's tool result
 * is lost → resume synthesizes "[recovered]" → the model rewrites → same hang
 * again (the "write 卡住 → 丢工具返回" loop, root-caused 2026-07-08).
 *
 * The diff here is display-only (uiContent) / diagnostics-narrowing — losing
 * it degrades a tool card, never correctness.  The pool path uses a 4s timeout
 * (worker thread doesn't block the event loop); this 1s value is the inline
 * floor when the pool is unavailable.
 */
const DIFF_TIMEOUT_MS = 1000
/** Worker-thread timeout — longer because it doesn't block the main thread. */
const POOL_DIFF_TIMEOUT_MS = 4000

/** Normalize Windows backslash paths to POSIX for clean diff headers. */
function normPath(p: string): string {
  return p.replaceAll('\\', '/')
}

export interface BuildFileDiffOptions {
  /** Cap rendered diff lines; excess is replaced by a single hint line. */
  maxLines?: number
}

/**
 * Build a unified diff between `before` and `after` for `relPath`.
 * Returns '' when there is no textual change (identical or empty hunk set).
 *
 * Tries the worker pool first (4s, non-blocking), falls back to inline (1s).
 */
export async function buildFileDiff(
  relPath: string,
  before: string,
  after: string,
  opts?: BuildFileDiffOptions,
): Promise<string> {
  if (before === after) return ''
  const posixPath = normPath(relPath)

  // Try worker pool first with a longer timeout (non-blocking)
  let raw: string | undefined
  if (cpuPool.available) {
    try {
      raw = (await cpuPool.run('diffUnifiedRaw', [posixPath, before, after, POOL_DIFF_TIMEOUT_MS])) as
        | string
        | undefined
    } catch {
      // Pool unavailable or timed out — fall through to inline
    }
  }

  // Inline fallback
  if (raw === undefined) {
    raw = diffUnifiedRaw(posixPath, before, after, DIFF_TIMEOUT_MS)
  }
  if (raw === undefined) return ''

  // createTwoFilesPatch prepends an `Index:` + `===` preamble (INCLUDE_HEADERS
  // default). Drop everything before the first `--- ` file header for a clean
  // git-style unified diff that still satisfies isDiffContent() (---/+++/@@).
  const allLines = raw.split('\n')
  const headerIdx = allLines.findIndex(l => l.startsWith('--- '))
  let body = headerIdx >= 0 ? allLines.slice(headerIdx) : allLines
  while (body.length > 0 && body[body.length - 1] === '') body.pop()

  // No hunk header → no real change (e.g. only trailing-newline noise).
  if (!body.some(l => l.startsWith('@@'))) return ''

  const maxLines = opts?.maxLines ?? DEFAULT_MAX_DIFF_LINES
  if (body.length > maxLines) {
    const hidden = body.length - maxLines
    body = [...body.slice(0, maxLines), `… (${hidden} more diff lines, Ctrl+O)`]
  }

  return body.join('\n')
}

/** A 1-based, inclusive line range in the AFTER file. */
export interface LineRange {
  start: number
  end: number
}

/**
 * Compute the line ranges (in the AFTER file, 1-based inclusive) touched by an
 * edit. Used by the LSP diagnostics narrowing at the tool-pipeline append site
 * to decide which whole-file diagnostics fall inside the "改动波及区".
 *
 * Uses a zero-context structured patch so each hunk maps to exactly the changed
 * after-lines. Pure deletions (newLines === 0) collapse to a single-line point
 * at the deletion boundary — the ±context in filterDiagnosticsForEdit widens it
 * enough to catch adjacent errors. A brand-new file (before === '') yields one
 * range covering the whole file. No change yields [].
 *
 * Tries the worker pool first (4s, non-blocking), falls back to inline (1s).
 */
export async function computeChangedLineRanges(
  before: string,
  after: string,
): Promise<LineRange[]> {
  if (before === after) return []

  // Try worker pool first with a longer timeout
  let hunks: RawHunk[] | undefined
  if (cpuPool.available) {
    try {
      const result = (await cpuPool.run('diffStructuredRaw', [
        before,
        after,
        POOL_DIFF_TIMEOUT_MS,
      ])) as { hunks: RawHunk[] } | undefined
      hunks = result?.hunks
    } catch {
      // Pool unavailable or timed out — fall through to inline
    }
  }

  // Inline fallback
  if (hunks === undefined) {
    const patch = diffStructuredRaw(before, after, DIFF_TIMEOUT_MS)
    hunks = patch?.hunks
  }

  // Diff too expensive to finish in time — conservatively treat the whole
  // AFTER file as changed (same shape as the brand-new-file case), so the
  // LSP diagnostics filter surfaces everything instead of hiding errors.
  if (hunks === undefined || hunks.length === 0) {
    const lineCount = after.length === 0 ? 1 : after.split('\n').length
    return [{ start: 1, end: lineCount }]
  }

  const ranges: LineRange[] = []
  for (const hunk of hunks) {
    const start = Math.max(1, hunk.newStart)
    const end = hunk.newLines > 0 ? start + hunk.newLines - 1 : start
    ranges.push({ start, end })
  }
  return ranges
}
