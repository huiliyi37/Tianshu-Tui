import { readFile, stat } from 'node:fs/promises'
import { createHash } from 'crypto'
import { relative } from 'node:path'
import type { Tool, ToolCallParams } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck } from './syntax-check.js'
import { detectPointerPlaceholder, pointerPlaceholderError } from './pointer-guard.js'
import { getFileReadMtime, noteFileObserved, recordSuccessfulEdit, wasFileEditedBySession } from './read-file.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { trackFileChange } from '../agent/recovery-stack.js'
import { detectEol, chooseEol, toLf, applyEol } from './line-endings.js'
import { getTargetEol } from '../platform.js'

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

  // Ready-to-use retry anchors: for each original anchor, substitute the
  // CURRENT hash at the same line (the diagnostic already computed it for
  // mismatches; verified anchors keep their hash). Only offered when every
  // anchor line still exists — an <eof> mismatch has no valid substitute.
  // Without this, the model has no recovery path in-context: "re-read" is a
  // dead end because read_file output carries no line hashes (only grep does),
  // so models loop on remembered dead anchors (2026-07-06 TDX session).
  const retryable = mismatches.every(m => m.actualHash !== '<eof>')
  const retryAnchors = retryable
    ? anchors.map(a => {
        const mismatch = mismatches.find(m => m.anchor === a)
        const hash = mismatch ? mismatch.actualHash : (a.hash ?? hashLine(lines[a.line - 1] ?? ''))
        return `"L${a.line}:${hash}"`
      }).join(', ')
    : null

  return [
    `hash_edit failed on ${filePath}: ${mismatches.length} anchor(s) stale.`,
    'The file has changed since your last read_file (possibly by your own earlier edit).',
    '',
    'Expected anchors:',
    all_anchors,
    '',
    'Stale anchors (with CURRENT hash at that line):',
    lines_of_evidence,
    '',
    ...(retryAnchors
      ? [
          `If the "content" shown above is the line you intend to replace, retry NOW with: anchors: [${retryAnchors}]`,
          'If it is not the right line, re-locate the target with grep (grep output includes fresh L<line>:<hash> anchor hints; read_file does NOT emit hashes).',
        ]
      : [
          'Anchor line numbers exceed the current file length. Re-locate the target with grep (grep output includes fresh L<line>:<hash> anchor hints; read_file does NOT emit hashes).',
        ]),
    'Do NOT retry with the anchors you already used — they are one-shot coordinates and this exact call will fail again.',
  ].join('\n')
}

export const HASH_EDIT_TOOL: Tool = {
  definition: {
    name: 'hash_edit',
    description: `Content-hash anchored file editing. Safer alternative to edit_file.

Anchors use format L<line>:<8-char-hex> (full hash verification) or L<line>
(position-only fast path — use only when you just read the file). Supply 1-3
anchors: first and last define the inclusive replacement range; a middle anchor
validates the interior. Single-anchor mode inserts content after that line.

Hash: SHA256(line_content_without_trailing_cr)[0:8].
Grep results include anchor hints for single-file matches.

⚠ Position-only: never chain consecutive calls — each hash_edit changes the
file, invalidating subsequent L<line> anchors.

Note: For large new_string, the message history keeps only a short pointer
(file_path + size). Use read_file to review the current content in a later turn.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit. Provide this parameter first.' },
        anchors: {
          type: 'array',
          items: { type: 'string' },
          description: '1-3 anchors in "L<line>:<8-char-hex>" (full) or "L<line>" (position-only) format. First and last define the inclusive replacement range.',
        },
        new_string: { type: 'string', description: 'Replacement text for the anchored block. Use "" to delete. Provide this parameter last.' },
      },
      required: ['file_path', 'anchors', 'new_string'],
    },
  },

  async execute(params: ToolCallParams) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch (e) {
      return { content: `Error: ${e instanceof Error ? e.message : 'Path escapes project directory'}`, isError: true }
    }

    // Pointer-regurgitation guard: reject placeholder text echoed from message
    // history as new_string — otherwise the pointer line is spliced verbatim
    // into the file (observed in the 2026-07-06 word-batch report).
    const newStringInput = params.input.new_string
    if (typeof newStringInput === 'string') {
      const matchedPointer = detectPointerPlaceholder(newStringInput)
      if (matchedPointer) {
        return {
          content: pointerPlaceholderError({ toolName: 'hash_edit', field: 'new_string', matchedPrefix: matchedPointer, filePath }),
          isError: true,
        }
      }
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

    // Normalize to LF for line splitting/rebuild; restore the file's EOL on
    // write-back. Without this, splicing LF new_string lines into a CRLF file's
    // (still \r-terminated) lines produces a mixed-EOL file. hashLine already
    // strips trailing \r, so anchor matching is unaffected either way.
    const rawContent = await readFile(filePath, 'utf-8')
    const eol = chooseEol(filePath, detectEol(rawContent), getTargetEol())
    const content = toLf(rawContent)
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
    let positionDriftWarning = false
    if (posOnly) {
      const lastReadMtime = getFileReadMtime(filePath, params.sessionId)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        // File was modified since last read_file (likely by a prior hash_edit
        // in this turn). Position-only anchors may have drifted — flag for
        // warning, but still attempt the edit (line-existence check below
        // catches out-of-bounds).
        positionDriftWarning = true
        noteFileObserved(filePath, currentMtime, fileStat.size, params.sessionId)
      }
    }

    // Hard reject: position-only anchors are unsafe after any session file edit.
    // The first edit shifts line numbers; subsequent L<num> anchors point to
    // wrong content. Force the model to re-read and use full-hash anchors.
    if (posOnly && wasFileEditedBySession(filePath, params.sessionId)) {
      return {
        content: [
          `Error: position-only anchors blocked on ${filePath}`,
          `This file has been edited in the current session, so line numbers have shifted.`,
          `Re-read the file and use L<num>:<hash> anchors, or use edit_file instead.`,
        ].join('\n'),
        isError: true,
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
      // ── Stale recovery: attempt to find anchor content in current file ──
      // When full-hash anchors go stale (e.g. after a prior edit shifted line
      // numbers), search ±N lines around the expected position for matching
      // content. If ALL mismatching anchors are recovered, apply the edit with
      // updated anchors. If ANY cannot be found, fall through to the error.
      const SEARCH_WINDOW = 50
      const allFullHash = mismatches.every(m => m.anchor.hash !== null)
      if (allFullHash) {
        const recoveredAnchors: Anchor[] = anchors.map(a => ({ line: a.line, hash: a.hash }))
        let allRecovered = true
        let recoveredCount = 0

        for (const m of mismatches) {
          const targetHash = m.anchor.hash!
          const searchStart = Math.max(1, m.anchor.line - SEARCH_WINDOW)
          const searchEnd = Math.min(lines.length, m.anchor.line + SEARCH_WINDOW)
          let found = false
          for (let i = searchStart; i <= searchEnd; i++) {
            if (hashLine(lines[i - 1]!) === targetHash) {
              // Update this anchor to its new position
              const idx = recoveredAnchors.findIndex(a => a.line === m.anchor.line && a.hash === m.anchor.hash)
              if (idx >= 0) recoveredAnchors[idx] = { line: i, hash: targetHash }
              found = true
              recoveredCount++
              break
            }
          }
          if (!found) {
            allRecovered = false
            break
          }
        }

        if (allRecovered && recoveredAnchors.every(a => a.line > 0)) {
          // Re-validate ascending order after recovery
          let orderOk = true
          for (let i = 1; i < recoveredAnchors.length; i++) {
            if (recoveredAnchors[i]!.line <= recoveredAnchors[i - 1]!.line) { orderOk = false; break }
          }
          if (orderOk) {
            const firstLine = recoveredAnchors[0]!.line
            const lastLine = recoveredAnchors[recoveredAnchors.length - 1]!.line
            const newString = params.input.new_string as string

            const before = lines.slice(0, firstLine - 1)
            const after = lines.slice(lastLine)
            const newLines = newString === '' ? [] : newString.split('\n')
            const newContent = [...before, ...newLines, ...after].join('\n')

            const relPath = relative(params.cwd, filePath)
            trackFileChange(params.cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'hash_edit' })

            await writeFileAtomicAsync(filePath, applyEol(newContent, eol))
            await recordSuccessfulEdit(filePath, params.sessionId)
            const warn = await syntaxCheck(filePath, newContent)
            const recoveredInfo = recoveredCount > 0
              ? ` (auto-recovered ${recoveredCount} stale anchors)`
              : ''
            const staleAdvice = recoveredCount > 0 && anchors.length >= 2
              ? '\n\n⚠ Multiple anchors went stale — anchors are interdependent. Consider switching to edit_file for further edits to this file.'
              : ''
            const posDrift = positionDriftWarning
              ? '\n\n⚠ Position-only anchors used on a file modified since last read — line numbers may have drifted. Verify the result or use edit_file instead.'
              : ''
            return { content: `hash_edit${recoveredInfo} applied to ${filePath}: replaced L${firstLine}-L${lastLine} (${lastLine - firstLine + 1} lines) with ${newLines.length} lines` + (warn ? '\n\n' + warn : '') + staleAdvice + posDrift }
          }
        }
      }

      // Recovery not possible — return the original stale diagnostic
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

    // Record file change for recovery tracking (backup created by trackFileChange)
    const relPath = relative(params.cwd, filePath)
    trackFileChange(params.cwd, { filePath: relPath, action: 'edit', toolCallId: params.toolUseId ?? 'hash_edit' })

    await writeFileAtomicAsync(filePath, applyEol(newContent, eol))
    await recordSuccessfulEdit(filePath, params.sessionId)
    const warn = await syntaxCheck(filePath, newContent)
    const posDrift = positionDriftWarning
      ? '\n\n⚠ Position-only anchors used on a file modified since last read — line numbers may have drifted. Verify the result or use edit_file instead.'
      : ''
    return { content: `hash_edit applied to ${filePath}: replaced L${firstLine}-L${lastLine} (${lastLine - firstLine + 1} lines) with ${newLines.length} lines` + (warn ? '\n\n' + warn : '') + posDrift }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
