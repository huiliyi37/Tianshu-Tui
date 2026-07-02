/**
 * Split a multi-file unified diff (e.g. `gh pr diff <n>`) into per-file patches
 * so each file can be rendered in its own collapsible DiffView card.
 *
 * Each chunk keeps its original `diff --git` / `+++ b/path` headers so the
 * DiffView parser still resolves the per-line `file` anchor correctly — that's
 * what lets line-level review comments anchor uniquely.
 */
export interface FileDiff {
  path: string
  patch: string
}

/** Strip the leading `a/` or `b/` git prefix from a diff path (keep /dev/null). */
function stripGitPrefix(p: string): string {
  if (p === '/dev/null') return p
  if (p.startsWith('a/') || p.startsWith('b/')) return p.slice(2)
  return p
}

/** Best-effort file path for one `diff --git` chunk. Prefers the new-side path. */
function parsePathFromChunk(lines: string[]): string {
  // Prefer +++ b/path (new side), skipping /dev/null (deleted files).
  for (const l of lines) {
    if (l.startsWith('+++ ')) {
      const p = stripGitPrefix(l.slice(4).trim())
      if (p && p !== '/dev/null') return p
    }
  }
  // Fall back to the `diff --git a/x b/y` header (captures b/y).
  const header = lines[0] ?? ''
  const m = header.match(/^diff --git a\/(.+?) b\/(.+)$/)
  if (m) return m[2]!
  // Last resort: --- a/path (old side) for pure deletions.
  for (const l of lines) {
    if (l.startsWith('--- ')) {
      const p = stripGitPrefix(l.slice(4).trim())
      if (p && p !== '/dev/null') return p
    }
  }
  return ''
}

/** Split a unified diff into `{ path, patch }` chunks, one per `diff --git`. */
export function splitUnifiedDiffByFile(raw: string): FileDiff[] {
  if (!raw) return []
  const lines = raw.split('\n')
  const chunks: string[][] = []
  let current: string[] | null = null
  for (const line of lines) {
    if (line.startsWith('diff --git ')) {
      if (current) chunks.push(current)
      current = [line]
    } else if (current) {
      current.push(line)
    }
    // Any preamble before the first `diff --git` is ignored.
  }
  if (current) chunks.push(current)
  return chunks
    .map((chunk) => ({ path: parsePathFromChunk(chunk), patch: chunk.join('\n') }))
    .filter((f) => f.path)
}
