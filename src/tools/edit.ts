import { readFile, stat } from 'node:fs/promises'
import type { Tool, ToolCallParams } from './types.js'
import { validatePath } from './path-validate.js'
import { hashLine } from './hash-edit.js'
import { getFileReadMtime, refreshFileReadMtime, markSessionFileEdit, wasFileEditedBySession } from './read-file.js'
import { syntaxCheck } from './syntax-check.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { findFuzzyMatch, applyFuzzyReplacement } from './fuzzy-match.js'

// Large files are common (generated code, lockfiles, big modules). 100KB was
// far too small. 8MB reads comfortably into the Node heap; anything larger is
// almost certainly machine-generated and better edited with apply_patch/sed.
const MAX_EDIT_FILE_BYTES = 8 * 1024 * 1024 // 8MB


export const EDIT_FILE_TOOL: Tool = {
  definition: {
    name: 'edit_file',
    description: `Perform exact string replacements in existing files.

### Usage
- Read the file first before editing
- old_string must be unique in the file — include surrounding context if needed
- Preserve exact indentation (tabs/spaces) from the file
- Use replace_all to replace every occurrence of old_string
- Prefer editing existing files over creating new ones
- Choosing between editors: edit_file for exact unique-string swaps; hash_edit when whitespace makes old_string ambiguous or for large files; apply_patch for multi-file unified diffs

### Examples
Good: reading the file, finding the exact string with surrounding context, then replacing
Bad: editing without reading the file first
Bad: using a too-short old_string that matches multiple locations

**Note:** For unusually large edits, the message history keeps only a short pointer (file path + a preview of the old block) instead of the full old_string/new_string. The edit is still applied to disk in full — use \`read_file\` to review the current content in a later turn.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file to edit. Provide this parameter first.' },
        old_string: { type: 'string', description: 'The exact text to replace (must be unique in the file)' },
        new_string: { type: 'string', description: 'The replacement text' },
        replace_all: { type: 'boolean', description: 'Replace all occurrences of old_string (default: false)' },
        expected_count: {
          type: 'number',
          description: 'Expected number of replacements when replace_all is true. If actual count differs, a warning is returned so you can grep to verify no instances were missed (e.g. due to indentation differences).'
        },
      },
      required: ['file_path', 'old_string', 'new_string'],
    },
  },

  async execute(params: ToolCallParams) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }

    let fileStat: Awaited<ReturnType<typeof stat>>
    try {
      fileStat = await stat(filePath)
    } catch {
      return { content: `Error: File not found: ${filePath}`, isError: true }
    }

    // Stale file detection: if the file was modified externally since the
    // model's last read_file, reject the edit to prevent silent corruption.
    // hash_edit is the safe alternative — its anchor verification catches this.
    const currentMtime = fileStat.mtimeMs
    const lastReadMtime = getFileReadMtime(filePath)
    if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
      // Auto-refresh mtime cache to prevent read-edit-stale loop:
      refreshFileReadMtime(filePath, currentMtime)

      // Smart stale recovery: instead of a generic "re-read" error, auto-read
      // the current content and either re-apply or show what changed.
      const oldString = params.input.old_string as string
      try {
        // OOM guard: check file size before reading (same as normal path above)
        if (fileStat.size > MAX_EDIT_FILE_BYTES) {
          return { content: `File was modified externally and is now too large (${Math.round(fileStat.size / 1024 / 1024)}MB > ${MAX_EDIT_FILE_BYTES / 1024 / 1024}MB limit) for auto-recovery. Use hash_edit with current anchors instead.`, isError: true }
        }
        const freshContent = await readFile(filePath, 'utf-8')
        const freshLines = freshContent.split('\n')

        if (freshContent.includes(oldString)) {
          // old_string still matches — just re-apply the edit
          const newString = params.input.new_string as string
          const replaceAll = (params.input.replace_all as boolean) ?? false
          if (replaceAll) {
            const newContent = freshContent.replaceAll(oldString, newString)
            await writeFileAtomicAsync(filePath, newContent)
            refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
            markSessionFileEdit(filePath)
            const occurrences = (freshContent.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
            const expectedCount = params.input.expected_count as number | undefined
            const warn = syntaxCheck(filePath, newContent)
            if (expectedCount !== undefined && occurrences !== expectedCount) {
              const base = `File was modified externally but old_string still matched. Warning: expected ${expectedCount} replacements but only replaced ${occurrences} in ${filePath}. Use grep to verify no instances were missed — different indentation or whitespace can cause partial matches with replace_all.`
              return { content: base + (warn ? '\n\n' + warn : '') }
            }
            return { content: `File was modified externally but old_string still matched. Re-applied ${occurrences} replacement(s) in ${filePath}${warn ? '\n\n' + warn : ''}` }
          }
          const firstIdx = freshContent.indexOf(oldString)
          const secondIdx = freshContent.indexOf(oldString, firstIdx + oldString.length)
          if (secondIdx !== -1) {
            return { content: buildMultipleMatchError(filePath, oldString, freshContent), isError: true }
          }
          const recovered = freshContent.replace(oldString, newString)
          await writeFileAtomicAsync(filePath, recovered)
          refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
          markSessionFileEdit(filePath)
          const warn = syntaxCheck(filePath, recovered)
          return { content: `Applied edit to ${filePath} (file was modified externally but content still matched)${warn ? '\n\n' + warn : ''}` }
        }

        // old_string not found — show what the file actually looks like near the best guess
        const oldFirstLine = oldString.split('\n')[0] ?? ''
        const trimmedTarget = oldFirstLine.trim()
        let bestIdx = -1
        let bestScore = 0
        for (let i = 0; i < freshLines.length; i++) {
          const trimmed = freshLines[i]!.trim()
          if (trimmed.length === 0) continue
          const score = sharedPrefixLength(trimmed, trimmedTarget)
          if (score > bestScore) { bestScore = score; bestIdx = i }
        }

        const CONTEXT = 5
        if (bestIdx >= 0 && bestScore >= Math.max(8, Math.floor(trimmedTarget.length * 0.3))) {
          const start = Math.max(0, bestIdx - CONTEXT)
          const end = Math.min(freshLines.length, bestIdx + oldString.split('\n').length + CONTEXT)
          const actualWindow = freshLines.slice(start, end).map((l, i) => `${start + i + 1}: ${l}`).join('\n')
          const modNote = wasFileEditedBySession(filePath) ? ' — you previously edited this file in the current session' : ' externally'
          return {
            content: `File ${filePath} was modified${modNote} since your last read_file. old_string no longer matches.\n\nCurrent content near the expected location (line ${bestIdx + 1}):\n\`\`\`\n${actualWindow}\n\`\`\`\n\nUpdate your old_string to match the current content and retry, or use hash_edit with anchors.`,
            isError: true,
          }
        }

        // No close match — show file head
        const head = freshLines.slice(0, 30).map((l, i) => `${i + 1}: ${l}`).join('\n')
        const modNote = wasFileEditedBySession(filePath) ? ' — you previously edited this file in the current session' : ' externally'
        return {
          content: `File ${filePath} was modified${modNote} since your last read_file. old_string not found.\n\nFile head:\n\`\`\`\n${head}${freshLines.length > 30 ? `\n... (${freshLines.length} lines total)` : ''}\n\`\`\`\n\nRe-read the file to see full content, or use hash_edit with anchors.`,
          isError: true,
        }
      } catch {
        return {
          content: `Error: File ${filePath} has been modified since your last read_file. Re-read the file to update your view.`,
          isError: true,
        }
      }
    }

    // OOM guard: reject only truly huge files that would blow the heap.
    if (fileStat.size > MAX_EDIT_FILE_BYTES) {
      const sizeMB = (fileStat.size / 1024 / 1024).toFixed(1)
      return {
        content: `Error: File too large for edit_file (${sizeMB}MB > ${MAX_EDIT_FILE_BYTES / 1024 / 1024}MB). Use apply_patch with a unified diff for targeted edits, or use bash with sed for simple string replacements on very large files.`,
        isError: true,
      }
    }

    const content = await readFile(filePath, 'utf-8')
    const oldString = params.input.old_string as string
    const newString = params.input.new_string as string
    const replaceAll = (params.input.replace_all as boolean) ?? false

    if (replaceAll) {
      if (!content.includes(oldString)) {
        return {
          content: buildNotFoundError(filePath, oldString, content),
          isError: true,
        }
      }
      const newContent = content.replaceAll(oldString, newString)
      await writeFileAtomicAsync(filePath, newContent)
      refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
      markSessionFileEdit(filePath)
      const occurrences = (content.match(new RegExp(escapeRegExp(oldString), 'g')) || []).length
      const expectedCount = params.input.expected_count as number | undefined
      const warn = syntaxCheck(filePath, newContent)
      if (expectedCount !== undefined && occurrences !== expectedCount) {
        const base = `Warning: expected ${expectedCount} replacements but only replaced ${occurrences} in ${filePath}. The file has been modified. Use grep to verify that no instances were missed — different indentation or whitespace can cause partial matches with replace_all.`
        return { content: base + (warn ? '\n\n' + warn : '') }
      }
      return { content: `Replaced all ${occurrences} occurrences in ${filePath}` + (warn ? '\n\n' + warn : '') }
    }

    const firstIndex = content.indexOf(oldString)
    if (firstIndex === -1) {
      // Whitespace-tolerant fallback: if the block exists modulo indentation /
      // tab-vs-space / trailing-space drift AND is unique, splice the edit onto
      // the file's real text instead of bouncing back a "not found" error.
      const fuzzy = findFuzzyMatch(content, oldString)
      if (fuzzy) {
        const recovered = applyFuzzyReplacement(content, fuzzy, newString)
        await writeFileAtomicAsync(filePath, recovered)
        refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
        markSessionFileEdit(filePath)
        const warn = syntaxCheck(filePath, recovered)
        return { content: `Applied edit to ${filePath} (whitespace-tolerant match: old_string differed only in indentation/whitespace)` + (warn ? '\n\n' + warn : '') }
      }
      return {
        content: buildNotFoundError(filePath, oldString, content),
        isError: true,
      }
    }
    const secondIndex = content.indexOf(oldString, firstIndex + 1)
    if (secondIndex !== -1) {
      return {
        content: buildMultipleMatchError(filePath, oldString, content),
        isError: true,
      }
    }
    const newContent = content.replace(oldString, newString)
    await writeFileAtomicAsync(filePath, newContent)
    refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
    markSessionFileEdit(filePath)
    const warn = syntaxCheck(filePath, newContent)
    return { content: `Applied edit to ${filePath}` + (warn ? '\n\n' + warn : '') }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}

function escapeRegExp(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * When old_string is not found, locate the closest substring in the file
 * and emit a unified-style diff so the model can see what its old_string
 * "looked like" in reality. Common failure modes this catches:
 *   - whitespace mismatch (tabs vs spaces, trailing spaces, CRLF vs LF)
 *   - off-by-one characters from manual transcription
 *   - line that "looks" the same but has subtle Unicode differences
 */
function buildNotFoundError(filePath: string, oldString: string, fileContent: string): string {
  const oldLines = oldString.split('\n')
  const firstLine = oldLines[0] ?? ''
  const lastLine = oldLines[oldLines.length - 1] ?? ''

  // Strategy: find the file line whose trimmed content most closely matches
  // the trimmed first line of old_string. Then extract a window of size
  // matching old_string's line count. This handles indentation drift well.
  const fileLines = fileContent.split('\n')
  const trimmedFirst = firstLine.trim()
  const trimmedLast = lastLine.trim()

  let bestIdx = -1
  let bestScore = 0
  for (let i = 0; i < fileLines.length; i++) {
    const trimmed = fileLines[i]!.trim()
    if (trimmed.length === 0) continue
    const score = sharedPrefixLength(trimmed, trimmedFirst)
    if (score > bestScore) {
      bestScore = score
      bestIdx = i
    }
  }

  // Require a meaningful match: at least 8 chars or 30% of the first line.
  const minScore = Math.max(8, Math.floor(trimmedFirst.length * 0.3))
  if (bestIdx === -1 || bestScore < minScore) {
    return `Error: old_string not found in ${filePath}. The file does not contain anything closely resembling the first line of old_string. Re-read the file to see its current contents.`
  }

  // Extract a window of the same line count as old_string from the file.
  const windowSize = oldLines.length
  const start = bestIdx
  const end = Math.min(fileLines.length, start + windowSize)
  const actualWindow = fileLines.slice(start, end).join('\n')

  // If the trimmed last line also matches better with a longer window, expand.
  // (Rare, but helps when the model's old_string skipped middle lines.)
  if (trimmedLast.length > 0 && windowSize > 1) {
    for (let extend = end; extend < Math.min(fileLines.length, start + windowSize + 5); extend++) {
      if (fileLines[extend]!.trim() === trimmedLast) {
        const expanded = fileLines.slice(start, extend + 1).join('\n')
        const hint = hashEditHint(fileContent, start + 1, extend + 1)
        return hint
          ? `${formatDiffError(filePath, oldString, expanded, start + 1)}\n\nHint: use hash_edit with these anchors instead:\n  ${hint}`
          : formatDiffError(filePath, oldString, expanded, start + 1)
      }
    }
  }

  const hint = hashEditHint(fileContent, start + 1, end)
  return hint
    ? `${formatDiffError(filePath, oldString, actualWindow, start + 1)}\n\nHint: use hash_edit with these anchors instead:\n  ${hint}`
    : formatDiffError(filePath, oldString, actualWindow, start + 1)
}

/**
 * When old_string matches multiple locations, show the line number and
 * surrounding context for each match so the model can pick the right one
 * and add disambiguating context.
 */
function buildMultipleMatchError(filePath: string, oldString: string, fileContent: string): string {
  const matches: Array<{ lineNumber: number; context: string }> = []
  let searchFrom = 0
  while (matches.length < 3) {
    const idx = fileContent.indexOf(oldString, searchFrom)
    if (idx === -1) break
    const lineNumber = fileContent.slice(0, idx).split('\n').length
    // Show the line containing the match plus 1 line above and below.
    const lines = fileContent.split('\n')
    const ctxStart = Math.max(0, lineNumber - 2)
    const ctxEnd = Math.min(lines.length, lineNumber + 1)
    const context = lines.slice(ctxStart, ctxEnd)
      .map((l, i) => `${ctxStart + i + 1}: ${l}`)
      .join('\n')
    matches.push({ lineNumber, context })
    searchFrom = idx + oldString.length
  }

  const matchSummary = matches
    .map((m, i) => {
      const startLine = m.lineNumber
      const endLine = startLine + oldString.split('\n').length - 1
      const anchors = hashEditHint(fileContent, startLine, endLine)
      const hint = anchors ? `\n  Hint: use hash_edit anchors=["${anchors.split('  ').join('", "')}"]` : ''
      return `Match ${i + 1} at line ${m.lineNumber}:\n${m.context}${hint}`
    })
    .join('\n\n')

  return `Error: old_string matches multiple locations in ${filePath}. Use replace_all=true to replace every occurrence, or extend old_string with surrounding context to make it unique.\n\nMatches found:\n\n${matchSummary}`
}

function formatDiffError(filePath: string, oldString: string, actualWindow: string, startLine: number): string {
  const oldLines = oldString.split('\n')
  const actualLines = actualWindow.split('\n')

  const diffLines: string[] = []
  diffLines.push(`--- expected (your old_string)`)
  diffLines.push(`+++ actual (file at line ${startLine})`)

  const maxLen = Math.max(oldLines.length, actualLines.length)
  for (let i = 0; i < maxLen; i++) {
    const exp = oldLines[i]
    const act = actualLines[i]
    if (exp === act) {
      diffLines.push(`  ${exp ?? ''}`)
    } else {
      if (exp !== undefined) diffLines.push(`- ${exp}`)
      if (act !== undefined) diffLines.push(`+ ${act}`)
    }
  }

  return `Error: old_string not found in ${filePath}. Closest match found at line ${startLine}:\n\n${diffLines.join('\n')}\n\nFix old_string to match the actual file content (check whitespace, indentation, and line endings) and retry.`
}

/** Length of common prefix between two strings. Used as a cheap similarity score. */
function sharedPrefixLength(a: string, b: string): number {
  const limit = Math.min(a.length, b.length)
  let i = 0
  while (i < limit && a[i] === b[i]) i++
  return i
}

/** Generate hash_edit anchor hints for the given line range in fileContent.
 *  Returns a string like "L42:a1b2c3d4  L44:e5f6a7b8" or null if out of range. */
function hashEditHint(fileContent: string, startLine: number, endLine: number): string | null {
  const fileLines = fileContent.split('\n')
  if (startLine < 1 || endLine > fileLines.length || startLine > endLine) return null
  const first = `L${startLine}:${hashLine(fileLines[startLine - 1]!)}`
  if (startLine === endLine) return first
  const last = `L${endLine}:${hashLine(fileLines[endLine - 1]!)}`
  return `${first}  ${last}`
}
