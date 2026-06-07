import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'crypto'
import type { Tool, ToolCallParams } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck } from './syntax-check.js'
import { getFileReadMtime, refreshFileReadMtime } from './read-file.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'

/**
 * Compute a 8-char hex hash of a line's content (stripped of trailing \r).
 * The hash is collision-resistant enough for anchor matching within a single
 * file — two different lines producing the same hash is astronomically unlikely
 * (1 in 2^32).
 */
export function hashLine(line: string): string {
  const clean = line.endsWith('\r') ? line.slice(0, -1) : line
  return createHash('sha256').update(clean).digest('hex').slice(0, 8)
}

interface Anchor {
  line: number      // 1-based
  hash: string | null  // 8-char hex, or null for position-only mode
}

/** Parse "L<num>:<hex>" or "L<num>" into { line, hash }.
 *  Returns null on parse failure. */
function parseAnchor(raw: string): Anchor | null {
  // Full format: L<num>:<8-char-hex>
  const fullMatch = /^L(\d+):([0-9a-f]{8})$/.exec(raw)
  if (fullMatch) {
    const line = parseInt(fullMatch[1]!, 10)
    if (line < 1) return null
    return { line, hash: fullMatch[2]! }
  }
  // Position-only format: L<num>
  const posMatch = /^L(\d+)$/.exec(raw)
  if (posMatch) {
    const line = parseInt(posMatch[1]!, 10)
    if (line < 1) return null
    return { line, hash: null }
  }
  return null
}

function formatStaleDiagnostic(
  filePath: string,
  anchors: Anchor[],
  lines: string[],
  mismatches: Array<{ anchor: Anchor; actualHash: string; actualLine: string }>,
): string {
  const lines_of_evidence = mismatches.map(m => {
    const ctx = lines[m.anchor.line - 1] ?? '<line not found>'
    return `  L${m.anchor.line}: expected ${m.anchor.hash} | actual ${m.actualHash} | content: ${ctx.slice(0, 60)}`
  }).join('\n')

  const all_anchors = anchors.map(a => `  L${a.line}:${a.hash}`).join('\n')

  return [
    `hash_edit failed on ${filePath}: ${mismatches.length} anchor(s) stale.`,
    'The file has changed since your last read_file. Re-read the relevant portion and retry with updated anchors.',
    '',
    'Expected anchors:',
    all_anchors,
    '',
    'Stale anchors:',
    lines_of_evidence,
  ].join('\n')
}

export const HASH_EDIT_TOOL: Tool = {
  definition: {
    name: 'hash_edit',
    description: `Content-hash anchored file editing. Safer alternative to edit_file.

### Why use hash_edit instead of edit_file
- No whitespace ambiguity — anchors are L<num>:<8-char-hex-hash>
- No "unique in file" requirement — each anchor is line-specific
- Stale file detection — if the file changed since your read, the edit is rejected
- Token efficiency — anchors are tiny compared to reproducing content verbatim

### How anchors work
After reading a file, compute the hash of each target line:
  L5:a1b2c3d4 means "line 5's content hashes to a1b2c3d4"

Supply 1-3 anchors that identify the block to replace. The first and last anchor
define the inclusive range; a middle anchor validates the interior.

### Examples
Replace lines 5-7 (3 lines) with new content:
  hash_edit(file_path="/abs/path/src/app.ts", anchors=["L5:a1b2c3d4", "L7:e5f6a7b8"], new_string="new line 5\\nnew line 6\\nnew line 7")

Delete lines 10-12:
  hash_edit(file_path="/abs/path/src/app.ts", anchors=["L10:deadbeef", "L12:cafebabe"], new_string="")

Insert after line 42 (anchor points to line 42, replace 0 lines):
  hash_edit(file_path="/abs/path/src/app.ts", anchors=["L42:feedface"], new_string="inserted line\\n")

### Position-only mode (fast path)
When you just read the file and are confident it hasn't changed, omit the hash:
  hash_edit(file_path="/abs/path/src/app.ts", anchors=["L5", "L7"], new_string="new line 5\\nnew line 6\\nnew line 7")
This verifies the line number exists AND checks that the file has not been
modified by another tool since your last read_file (same staleness guard as
edit_file). Use when you just read the file — never chain position-only calls.

### Hash computation
The hash is SHA256(line_content_without_trailing_cr)[0:8].
Use read_file first to see current content, then construct anchors from the lines you want to target.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit' },
        anchors: {
          type: 'array',
          items: { type: 'string' },
          description: '1-3 anchors in "L<line>:<8-char-hex>" (full) or "L<line>" (position-only) format. First and last define the inclusive replacement range.',
        },
        new_string: { type: 'string', description: 'Replacement text for the anchored block. Use "" to delete.' },
      },
      required: ['file_path', 'anchors', 'new_string'],
    },
  },

  async execute(params: ToolCallParams) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string)
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }

    // Check file exists asynchronously
    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(filePath)
    } catch {
      return { content: `Error: File not found: ${filePath}`, isError: true }
    }

    const rawAnchors = params.input.anchors as string[] | undefined
    if (!rawAnchors || rawAnchors.length === 0 || rawAnchors.length > 3) {
      return { content: 'Error: anchors must be an array of 1-3 "L<line>:<hash>" or "L<line>" strings', isError: true }
    }

    const anchors: Anchor[] = []
    for (const raw of rawAnchors) {
      const parsed = parseAnchor(raw)
      if (!parsed) {
        return { content: `Error: invalid anchor format "${raw}". Expected "L<num>:<8-char-hex>" (e.g. "L5:a1b2c3d4") or "L<num>" (e.g. "L5")`, isError: true }
      }
      anchors.push(parsed)
    }

    // Ascending order check: anchors must be in strictly increasing line order
    // for first/last to define a valid replacement range. Reversed anchors
    // cause line duplication and silent file corruption.
    for (let i = 1; i < anchors.length; i++) {
      if (anchors[i]!.line <= anchors[i - 1]!.line) {
        return {
          content: `Error: anchors must be in strictly ascending line order. ` +
            `Anchor ${i + 1} (L${anchors[i]!.line}) is not after anchor ${i} (L${anchors[i - 1]!.line}).`,
          isError: true,
        }
      }
    }

    const content = await readFile(filePath, 'utf-8')
    const lines = content.split('\n')

    // Staleness guard for position-only anchors: if every anchor omits the
    // hash (fast-path mode), the file must not have been modified since the
    // last read_file.  Without this check, consecutive position-only
    // hash_edit calls on the same file silently operate on shifted line
    // numbers — the first edit changes the file, and the second edit's
    // L<num> anchors point to wrong locations because the tool never
    // verifies content after the first mutation.
    const currentMtime = fileStat.mtimeMs
    const posOnly = anchors.every(a => a.hash === null)
    if (posOnly) {
      const lastReadMtime = getFileReadMtime(filePath)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        return {
          content: [
            `hash_edit position-only stale guard: ${filePath} was modified since your last read_file.`,
            `Last read mtime: ${lastReadMtime}, current mtime: ${currentMtime}.`,
            'Re-read the relevant portion and retry with updated anchors, or use full L<num>:<hash> anchors.',
          ].join('\n'),
          isError: true,
        }
      }
    }

    // Verify all anchors — compute line hashes and match
    const mismatches: Array<{ anchor: Anchor; actualHash: string; actualLine: string }> = []
    for (const anchor of anchors) {
      if (anchor.line > lines.length) {
        mismatches.push({ anchor, actualHash: '<eof>', actualLine: '<line number exceeds file length>' })
        continue
      }
      if (anchor.hash !== null) {
        // Full hash verification
        const actualHash = hashLine(lines[anchor.line - 1]!)
        if (actualHash !== anchor.hash) {
          mismatches.push({ anchor, actualHash, actualLine: lines[anchor.line - 1]! })
        }
      }
      // Position-only anchors (hash === null) only verify line exists — already checked above
    }

    if (mismatches.length > 0) {
      return {
        content: formatStaleDiagnostic(filePath, anchors, lines, mismatches),
        isError: true,
      }
    }

    // All anchors verified — apply the edit
    const firstLine = anchors[0]!.line
    const lastLine = anchors[anchors.length - 1]!.line
    const newString = params.input.new_string as string

    // Build the new file content
    const before = lines.slice(0, firstLine - 1)
    const after = lines.slice(lastLine) // lastLine is 1-based inclusive, slice is exclusive
    const newLines = newString === '' ? [] : newString.split('\n')
    const newContent = [...before, ...newLines, ...after].join('\n')

    await writeFileAtomicAsync(filePath, newContent)
    refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
    const warn = syntaxCheck(filePath, newContent)
    return { content: `hash_edit applied to ${filePath}: replaced L${firstLine}-L${lastLine} (${lastLine - firstLine + 1} lines) with ${newLines.length} lines` + (warn ? '\n\n' + warn : '') }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
