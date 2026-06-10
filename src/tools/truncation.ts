const TRUNCATION_NOTE = '... (truncated, use offset/limit for more specific ranges)'

export function truncateContent(
  content: string,
  maxChars: number,
  keepHead: number,
  keepTail: number,
): string {
  if (content.length <= maxChars) return content

  const head = content.slice(0, keepHead)
  const tail = content.slice(-keepTail)
  return `${head}\n${TRUNCATION_NOTE}\n${tail}`
}

/**
 * Build a PARTIAL view of a large file: returns the first N lines that fit
 * within the character budget, plus metadata and navigation hints so the model
 * knows how to read the rest via offset/limit or grep.
 *
 * Unlike head+tail truncation, this returns **contiguous** content from the
 * start of the file — the model never sees spliced fragments.
 */
export function buildPartialView(content: string, filePath: string, maxChars: number): string {
  const lines = content.split('\n')
  const totalLines = lines.length
  const totalChars = content.length

  const HEADER_OVERHEAD = 300
  const budget = Math.max(0, maxChars - HEADER_OVERHEAD)

  let keptLines = 0
  let keptChars = 0
  while (keptLines < totalLines && keptChars + (lines[keptLines]?.length ?? 0) + 1 <= budget) {
    keptChars += lines[keptLines]!.length + 1
    keptLines++
  }
  keptLines = Math.max(1, keptLines)

  const firstPage = lines.slice(0, keptLines).join('\n')
  return [
    `── PARTIAL view of ${filePath} (${totalLines} lines, ${totalChars} chars) ──`,
    `Showing lines 1-${keptLines} of ${totalLines}.`,
    `To read more: read_file(file_path="${filePath}", offset=${keptLines + 1}, limit=200)`,
    `To find specific code: use grep first, then read_file with offset/limit.`,
    `For editing: use grep to locate the target line, then hash_edit with anchors — no full read needed.`,
    '',
    firstPage,
  ].join('\n')
}
