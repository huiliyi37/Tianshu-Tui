import { readFileSync, existsSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'

// Cache GitignoreFilter instances by cwd to avoid re-reading .gitignore on every call
const gitignoreCache = new Map<string, { filter: GitignoreFilter; ts: number }>()
const GITIGNORE_CACHE_TTL = 60_000 // 60 seconds

function getGitignoreFilter(cwd: string): GitignoreFilter {
  const cached = gitignoreCache.get(cwd)
  if (cached && Date.now() - cached.ts < GITIGNORE_CACHE_TTL) {
    return cached.filter
  }
  const filter = new GitignoreFilter(cwd)
  gitignoreCache.set(cwd, { filter, ts: Date.now() })
  return filter
}

export const READ_FILE_TOOL: Tool = {
  definition: {
    name: 'read_file',
    description: `Read files from the filesystem with optional line range.

### Usage
- Always provide absolute file paths
- Use offset and limit to read specific ranges instead of reading entire large files
- Results are truncated at 8000 characters — use offset/limit for large files
- This tool can read text files, images (PNG/JPG), and PDF files
- Do NOT re-read files already read in this session unless they were modified

### Examples
Good: read_file(file_path="/abs/path/src/app.ts")
Good: read_file(file_path="/abs/path/src/app.ts", offset=100, limit=50)
Bad: read_file(file_path="src/app.ts") (relative path)
Bad: re-reading the same file multiple times in one session without it being modified`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        offset: { type: 'integer', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'integer', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },

  async execute(params: ToolCallParams) {
    let filePath: string
    try {
      filePath = validatePath(params.cwd, params.input.file_path as string)
    } catch {
      return { content: 'Error: Path escapes project directory', isError: true }
    }
    if (!existsSync(filePath)) {
      return { content: `Error: File not found: ${filePath}`, isError: true }
    }

    const filter = getGitignoreFilter(params.cwd)
    if (filter.isIgnored(params.cwd, filePath)) {
      return { content: `Error: File is gitignored (node_modules, build artifacts, etc.): ${filePath}`, isError: true }
    }

    const content = readFileSync(filePath, 'utf-8')
    let lines = content.split('\n')
    const offset = (params.input.offset as number) ?? 1
    const limit = params.input.limit as number | undefined

    if (offset > 1 || limit) {
      const startIdx = offset - 1
      const endIdx = limit ? startIdx + limit : undefined
      lines = lines.slice(startIdx, endIdx)
    }

    return { content: truncateContent(lines.join('\n'), 8000, 4000, 2000) }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
