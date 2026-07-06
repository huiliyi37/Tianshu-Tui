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
import { WRITE_FILE_POINTER_PREFIX } from './write-file-arg-processor.js'

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
    } catch (e) {
      return { content: `Error: ${e instanceof Error ? e.message : 'Path escapes project directory'}`, isError: true }
    }
    const content = params.input.content as string
    const dir = dirname(filePath)

    // Pointer-regurgitation guard: the arg post-processor replaces large
    // `content` values in message history with a "[file written to …]" pointer.
    // Models occasionally echo that pointer back as the real content on a later
    // write, silently producing a one-line garbage file (session 05e1500e).
    if (content.trimStart().startsWith(WRITE_FILE_POINTER_PREFIX)) {
      return {
        content: `Error: content is a pointer placeholder from message history ("${WRITE_FILE_POINTER_PREFIX} …"), not real file contents. `
          + `Large write_file contents are replaced by this pointer in past messages — the actual text lives only on disk. `
          + `Provide the complete real file contents; if you need the previous version, read_file ${filePath} first.`,
        isError: true,
      }
    }

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
    let existingSize = 0
    // Old content (LF-normalized) as the diff base; '' → new file (all-additions).
    let oldContentForDiff = ''
    // When an existing file could not be read (binary, unreadable, or too large),
    // we intentionally skip the diff so the card falls back to the summary text
    // instead of showing a misleading all-additions diff.
    let haveOldContentForDiff = false
    try {
      const existingStat = await stat(filePath)
      fileExists = true
      existingSize = existingStat.size
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

    // Blind-overwrite guard (fail-closed): overwriting an existing file this
    // session never observed (no read_file / grep hit / prior own edit —
    // lastKnownFileState has no entry) destroys content the model has never
    // seen. Byte-identical rewrites are exempt (no information loss). After
    // the refusal a single read_file registers the observation and the next
    // write_file goes through — self-correcting, one extra tool call.
    if (
      fileExists
      && process.env.RIVET_WRITE_OVERWRITE_GUARD !== '0'
      && getFileReadMtime(filePath, params.sessionId) === null
      && !(haveOldContentForDiff && oldContentForDiff === toLf(content))
    ) {
      return {
        content: `Error: ${filePath} already exists (${existingSize} bytes) but was never read in this session. `
          + `Overwriting it blind would destroy content you have not seen. `
          + `read_file it first to confirm what you are replacing, then use edit_file for targeted changes `
          + `or call write_file again for a deliberate full rewrite.`,
        isError: true,
      }
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
