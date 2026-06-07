import { mkdir, stat } from 'node:fs/promises'
import { dirname } from 'path'
import type { Tool } from './types.js'
import { validatePath } from './path-validate.js'
import { syntaxCheck } from './syntax-check.js'
import { refreshFileReadMtime, getFileReadMtime } from './read-file.js'
import { writeFileAtomicAsync } from '../fs-atomic.js'

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
Bad: using write_file to change one line in an existing file (use edit_file instead)`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        content: { type: 'string', description: 'Content to write' },
      },
      required: ['file_path', 'content'],
    },
  },

  async execute(params) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string)
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

    // Staleness check: warn if file was read earlier and has since been modified
    // by another process/tool (prevents silent overwrite of external changes).
    try {
      const currentStat = await stat(filePath)
      const currentMtime = currentStat.mtimeMs
      const lastReadMtime = getFileReadMtime(filePath)
      if (lastReadMtime !== null && currentMtime !== lastReadMtime) {
        console.warn(`⚠ write_file: ${filePath} was modified externally since last read. Overwriting.`)
      }
    } catch {
      // File doesn't exist yet — skip staleness check
    }

    await writeFileAtomicAsync(filePath, content)
    refreshFileReadMtime(filePath, (await stat(filePath)).mtimeMs)
    const lines = content.split('\n').length
    const warn = syntaxCheck(filePath, content)
    return { content: `Wrote ${content.length} bytes (${lines} lines) to ${filePath}` + (warn ? '\n\n' + warn : '') }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
