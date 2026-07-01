import { createTwoFilesPatch, structuredPatch } from 'diff'

/**
 * Display-only unified diff for write-family tools (edit_file/write_file/…).
 *
 * The result is meant for the `uiContent` channel (TUI/desktop tool card),
 * never the model-facing `content` — so it must NOT enter conversation history
 * and has no prefix-cache cost. The TUI colors it via the existing
 * write-family + isDiffContent() branch in format/tool-card.ts.
 */

const DEFAULT_MAX_DIFF_LINES = 600

export interface BuildFileDiffOptions {
  /** Cap rendered diff lines; excess is replaced by a single hint line. */
  maxLines?: number
}

/**
 * Build a unified diff between `before` and `after` for `relPath`.
 * Returns '' when there is no textual change (identical or empty hunk set).
 */
export function buildFileDiff(relPath: string, before: string, after: string, opts?: BuildFileDiffOptions): string {
  if (before === after) return ''

  const raw = createTwoFilesPatch(relPath, relPath, before, after, '', '', { context: 3 })

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
 */
export function computeChangedLineRanges(before: string, after: string): LineRange[] {
  if (before === after) return []
  const patch = structuredPatch('a', 'a', before, after, '', '', { context: 0 })
  const ranges: LineRange[] = []
  for (const hunk of patch.hunks) {
    const start = Math.max(1, hunk.newStart)
    const end = hunk.newLines > 0 ? start + hunk.newLines - 1 : start
    ranges.push({ start, end })
  }
  return ranges
}
