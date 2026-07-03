import { mkdir, stat, readFile } from 'node:fs/promises'
import { dirname, relative } from 'path'
import type { Tool } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck } from './syntax-check.js'
import { getFileReadMtime, recordSuccessfulEdit } from './read-file.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'
import { trackFileChange } from '../agent/recovery-stack.js'
import { applyEol, chooseEol, detectFileEol, toLf } from './line-endings.js'
import { getTargetEol } from '../platform.js'
import { buildFileDiff, computeChangedLineRanges } from './edit-diff.js'

const MAX_WRITE_FILE_BYTES = 10 * 1024 * 1024 // 10MB — safety ceiling for single write_file call

export const WRITE_FILE_TOOL: Tool = {
  definition: {
    name: 'write_file',
    description: `Create or overwrite a file. Creates parent directories automatically.

### Usage
- Prefer edit_file for targeted changes to existing files
- Use write_file only for new files or complete file rewrites
- Always provide absolute file paths
- File content is the complete file contents, not a diff
- Parent directories are created if they don't exist

### Examples
Good: write_file(file_path="/abs/path/src/new-component.tsx", content="...full file content...")
Bad: using write_file to change one line in an existing file (use edit_file instead)

**Note:** The file on disk is the source of truth. For large writes, the message history keeps only a short pointer to \`file_path\` instead of the full content — use \`read_file\` if you need to review what was written in a later turn.`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file. Provide this parameter first.' },
        content: { type: 'string', description: 'Complete file contents (not a diff). Provide this parameter last.' },
      },
      required: ['file_path', 'content'],
    },
  },

  async execute(params) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string, 'write')
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }
    const content = params.input.content as string
    const dir = dirname(filePath)

    if (content.length > MAX_WRITE_FILE_BYTES) {
      const sizeMB = (content.length / (1024 * 1024)).toFixed(1)
      return {
        content: `Error: Content too large for write_file (${sizeMB}MB). Use bash to write large files via heredoc or stream redirection.`,
        isError: true,
      }
    }

    await mkdir(dir, { recursive: true })

    // If overwriting an existing file, back it up for recovery
    let fileExists = false
    // Old content (LF-normalized) as the diff base; '' → new file (all-additions).
    let oldContentForDiff = ''
    // When an existing file could not be read (binary, unreadable, or too large),
    // we intentionally skip the diff so the card falls back to the summary text
    // instead of showing a misleading all-additions diff.
    let haveOldContentForDiff = false
    try {
      const existingStat = await stat(filePath)
      fileExists = true
      if (existingStat.size <= MAX_WRITE_FILE_BYTES) {
        try {
          oldContentForDiff = toLf(await readFile(filePath, 'utf-8'))
          haveOldContentForDiff = true
        } catch {
          // Binary/unreadable — skip diff base, card falls back to summary text.
        }
      }
    } catch {
      // File doesn't exist yet — empty base is intentional; produce an all-additions diff.
      haveOldContentForDiff = true
    }
    if (fileExists) {
      const relPath = relative(params.cwd, filePath)
      trackFileChange(params.cwd, { filePath: relPath, action: 'write', toolCallId: params.toolUseId ?? 'write_file' })
    }

    // Staleness check: warn if file was read earlier and has since been modified
    // by another process/tool (prevents silent overwrite of external changes).
    try {
      const currentStat = await stat(filePath)
      const currentMtime = currentStat.mtimeMs
      const lastReadMtime = getFileReadMtime(filePath, params.sessionId)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        console.warn(`⚠ write_file: ${filePath} was modified externally since last read. Overwriting.`)
      }
    } catch {
      // File doesn't exist yet — skip staleness check
    }

    // Line-ending policy: force CRLF for Windows batch files, preserve an
    // existing file's dominant EOL on overwrite, default to LF for new files.
    // The LF branch is byte-identical to writing `content` verbatim.
    const existingEol = fileExists ? await detectFileEol(filePath) : null
    const finalContent = applyEol(content, chooseEol(filePath, existingEol, getTargetEol()))

    await writeFileAtomicAsync(filePath, finalContent)
    await recordSuccessfulEdit(filePath, params.sessionId)
    const lines = finalContent.split('\n').length
    const warn = syntaxCheck(filePath, finalContent)
    const afterForDiff = toLf(content)
    const diff = haveOldContentForDiff
      ? buildFileDiff(relative(params.cwd, filePath), oldContentForDiff, afterForDiff)
      : ''
    const uiContent = diff ? (warn ? `${diff}\n\n${warn}` : diff) : (warn ? warn : undefined)
    return {
      content: `Wrote ${finalContent.length} bytes (${lines} lines) to ${filePath}` + (warn ? '\n\n' + warn : ''),
      uiContent,
      changedRanges: haveOldContentForDiff ? computeChangedLineRanges(oldContentForDiff, afterForDiff) : [],
    }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
