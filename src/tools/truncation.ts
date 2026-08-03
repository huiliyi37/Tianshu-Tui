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

/** Real size of the file a fold skeleton was derived from. */
export interface SkeletonSource {
  lines: number
  chars: number
}

/**
 * Build a PARTIAL view of a large file: returns the first N lines that fit
 * within the character budget, plus metadata and navigation hints so the model
 * knows how to read the rest via offset/limit or grep.
 *
 * Unlike head+tail truncation, this returns **contiguous** content from the
 * start of the file — the model never sees spliced fragments.
 *
 * Pass `skeletonOf` when `content` is a fold skeleton rather than file text.
 * Without it the header would describe the skeleton's own size as the file's,
 * and "showing lines 1-79 of 79" reads as a complete file — the model has no
 * way to tell that prose and code bodies were dropped.
 */
export function buildPartialView(
  content: string,
  filePath: string,
  maxChars: number,
  skeletonOf?: SkeletonSource,
): string {
  const lines = content.split('\n')
  const totalLines = lines.length
  const totalChars = content.length

  const HEADER_OVERHEAD = skeletonOf ? 480 : 300
  const budget = Math.max(0, maxChars - HEADER_OVERHEAD)

  let keptLines = 0
  let keptChars = 0
  while (keptLines < totalLines && keptChars + (lines[keptLines]?.length ?? 0) + 1 <= budget) {
    keptChars += lines[keptLines]!.length + 1
    keptLines++
  }
  keptLines = Math.max(1, keptLines)

  const firstPage = lines.slice(0, keptLines).join('\n')
  const header = skeletonOf
    ? [
        `── SKELETON view of ${filePath} (${skeletonOf.lines} lines, ${skeletonOf.chars} chars) ──`,
        `This is NOT the file's text: it is a structural outline (${keptLines} of ${totalLines} outline lines).`,
        `Prose, comments and code bodies have been REMOVED — an empty block here means content was dropped, not that the file is empty.`,
        `To read the actual content: read_file(file_path="${filePath}", offset=1, limit=200), then page with offset.`,
      ]
    : [
        `── PARTIAL view of ${filePath} (${totalLines} lines, ${totalChars} chars) ──`,
        `Showing lines 1-${keptLines} of ${totalLines}.`,
        `To read more: read_file(file_path="${filePath}", offset=${keptLines + 1}, limit=200)`,
      ]
  return [
    ...header,
    `To find specific code: use grep first, then read_file with offset/limit.`,
    `For editing: use grep to locate the target line, then hash_edit with anchors — no full read needed.`,
    '',
    firstPage,
  ].join('\n')
}
