import { readFileSync, existsSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'
import { persistRawOutput } from './output-store.js'

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

const MODEL_MAX_CHARS = 8000
const MODEL_HEAD_CHARS = 4000
const MODEL_TAIL_CHARS = 2000

/** TUI display: head + tail with line numbers, compact for large files. */
function buildFileUiOutput(raw: string, maxLines: number): string {
  const lines = raw.split('\n')
  const totalLines = lines.length

  if (totalLines <= maxLines) {
    return lines.map((l, i) => `${String(i + 1).padStart(4, ' ')}│ ${l}`).join('\n')
  }

  const headLines = Math.ceil(maxLines * 0.6)
  const tailLines = Math.floor(maxLines * 0.4)
  const omitted = totalLines - headLines - tailLines

  const head = lines.slice(0, headLines)
    .map((l, i) => `${String(i + 1).padStart(4, ' ')}│ ${l}`)
  const tail = lines.slice(-tailLines)
    .map((l, i) => `${String(totalLines - tailLines + i + 1).padStart(4, ' ')}│ ${l}`)

  return [...head, `  ... ${omitted} lines omitted ...`, ...tail].join('\n')
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

    const raw = readFileSync(filePath, 'utf-8')
    let content = raw
    const offset = (params.input.offset as number) ?? 1
    const limit = params.input.limit as number | undefined

    if (offset > 1 || limit) {
      const lines = content.split('\n')
      const startIdx = offset - 1
      const endIdx = limit ? startIdx + limit : undefined
      content = lines.slice(startIdx, endIdx).join('\n')
    }

    // Persist full raw content so user can inspect large files via rawPath
    const rawPath = await persistRawOutput(params.toolUseId, content)

    // LLM gets char-capped head+tail for context efficiency
    const modelContent = truncateContent(content, MODEL_MAX_CHARS, MODEL_HEAD_CHARS, MODEL_TAIL_CHARS)

    // TUI gets line-numbered preview (50 lines)
    const uiContent = buildFileUiOutput(content, 50)

    return {
      content: modelContent,
      uiContent,
      rawPath,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
