import { readFileSync, existsSync, statSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'
import { persistRawOutput } from './output-store.js'
import { summarizeFileContent } from '../artifact/summarize.js'
import { computeModelReadCap, DEFAULT_MODEL_READ_CAP, type ModelReadCap } from './model-read-cap.js'

// Cache GitignoreFilter instances by cwd to avoid re-reading .gitignore on every call
const gitignoreCache = new Map<string, { filter: GitignoreFilter; ts: number }>()
const GITIGNORE_CACHE_TTL = 60_000 // 60 seconds
const GITIGNORE_CACHE_MAX = 50

function trimGitignoreCache(): void {
  if (gitignoreCache.size <= GITIGNORE_CACHE_MAX) return
  const now = Date.now()
  for (const [key, val] of gitignoreCache) {
    if (now - val.ts > GITIGNORE_CACHE_TTL) gitignoreCache.delete(key)
  }
  while (gitignoreCache.size > GITIGNORE_CACHE_MAX) {
    const [key] = gitignoreCache.keys()
    gitignoreCache.delete(key!)
  }
}

function getGitignoreFilter(cwd: string): GitignoreFilter {
  const cached = gitignoreCache.get(cwd)
  if (cached && Date.now() - cached.ts < GITIGNORE_CACHE_TTL) {
    return cached.filter
  }
  const filter = new GitignoreFilter(cwd)
  gitignoreCache.set(cwd, { filter, ts: Date.now() })
  trimGitignoreCache()
  return filter
}

const MAX_TOOL_INPUT_BYTES = 100 * 1024

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

export interface ReadFilePayloadOptions {
  filePath: string
  offset?: number
  limit?: number
  /** Per-call model read cap. Defaults to {@link DEFAULT_MODEL_READ_CAP}. */
  modelCap?: ModelReadCap
}

export interface ReadFilePayload {
  canonicalPath: string
  rawContent: string
  modelContent: string
  uiContent: string
}

/** Centralized safe file read — validates path, checks gitignore, applies offset/limit, truncates for model. */
export function readFilePayload(cwd: string, options: ReadFilePayloadOptions): ReadFilePayload {
  const filePath = validatePath(cwd, options.filePath)
  if (!existsSync(filePath)) {
    throw new Error(`File not found: ${filePath}`)
  }

  const filter = getGitignoreFilter(cwd)
  if (filter.isIgnored(cwd, filePath)) {
    throw new Error(`File is gitignored (node_modules, build artifacts, etc.): ${filePath}`)
  }

  const fileSize = statSync(filePath).size
  if (fileSize > MAX_TOOL_INPUT_BYTES && !options.offset && !options.limit) {
    const sizeKB = (fileSize / 1024).toFixed(0)
    const estLines = Math.ceil(fileSize / 80)
    throw new Error(
      `File too large (${sizeKB}KB, ~${estLines} lines). Use offset and limit to read specific ranges.`
    )
  }

  let content = readFileSync(filePath, 'utf-8')
  const offset = options.offset ?? 1
  const limit = options.limit

  if (offset > 1 || limit) {
    const lines = content.split('\n')
    const startIdx = offset - 1
    const endIdx = limit ? startIdx + limit : undefined
    content = lines.slice(startIdx, endIdx).join('\n')
  }

  const cap = options.modelCap ?? DEFAULT_MODEL_READ_CAP
  return {
    canonicalPath: filePath,
    rawContent: content,
    modelContent: truncateContent(content, cap.maxChars, cap.headChars, cap.tailChars),
    uiContent: buildFileUiOutput(content, 50),
  }
}

export const READ_FILE_TOOL: Tool = {
  definition: {
    name: 'read_file',
    description: `Read files from the filesystem with optional line range.

### Usage
- Always provide absolute file paths
- Use offset and limit to read specific ranges instead of reading entire large files
- Long files are truncated head+tail; the cap scales with the active context window — use offset/limit to read specific sections of large files
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
    let payload: ReadFilePayload
    try {
      payload = readFilePayload(params.cwd, {
        filePath: params.input.file_path as string,
        offset: (params.input.offset as number) ?? 1,
        limit: params.input.limit as number | undefined,
        modelCap: computeModelReadCap({
          contextWindow: params.contextWindow,
          providerProfile: params.providerProfile,
        }),
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }

    // P0-2 trace: verify read_file returns full content, not truncated
    // eslint-disable-next-line no-console
    console.warn(`[read-cap] file=${payload.canonicalPath} raw=${payload.rawContent.length} model=${payload.modelContent.length} truncated=${payload.rawContent.length !== payload.modelContent.length}`)

    const rawPath = await persistRawOutput(params.toolUseId, payload.rawContent)

    if (params.artifactStore) {
      const { summary, sections } = summarizeFileContent(payload.rawContent, payload.canonicalPath)
      const artifactId = await params.artifactStore.save({
        tool: 'read_file',
        target: payload.canonicalPath,
        rawContent: payload.rawContent,
        summary,
        sections,
      })
      // MODEL SEES FULL CODE — not just structural summary
      // Agent needs actual source to construct edit_file old_string
      const summaryBlock = summary.trim()
        ? `\n\n── Structural outline ──\n${summary.trim()}`
        : ''
      return {
        content: payload.modelContent + summaryBlock + `\n[artifact:${artifactId}]`,
        rawContent: payload.modelContent,
        uiContent: payload.uiContent,
        rawPath,
      }
    }

    return {
      content: payload.modelContent,
      uiContent: payload.uiContent,
      rawPath,
    }
  },

  requiresApproval: () => false,
  isConcurrencySafe: () => true,
  isEnabled: () => true,
}
