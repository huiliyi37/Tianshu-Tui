import { writeFileSync, mkdirSync, existsSync } from 'fs'
import { dirname } from 'path'
import type { Tool } from './types.js'
import { validatePath } from './path-validate.js'

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

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true })
    }

    writeFileSync(filePath, content, 'utf-8')
    const lines = content.split('\n').length
    return { content: `Wrote ${content.length} bytes (${lines} lines) to ${filePath}` }
  },

  requiresApproval: () => true,
  isConcurrencySafe: () => false,
  isEnabled: () => true,
}
