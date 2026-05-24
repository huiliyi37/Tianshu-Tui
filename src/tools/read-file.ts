import { readFileSync, existsSync, statSync } from 'fs'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'
import { persistRawOutput } from './output-store.js'
import { summarizeFileContent } from '../artifact/summarize.js'
import { computeModelReadCap, DEFAULT_MODEL_READ_CAP, type ModelReadCap } from './model-read-cap.js'
import { pruneThresholds } from '../compact/constants.js'

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

// P5+P6 follow-up: in-process dedup for read_file to prevent the model from
// burning tokens by repeatedly reading the same unchanged file. Key includes
// the file's mtime so an external edit (or our own write_file) auto-invalidates.
interface ReadHistoryEntry {
  mtimeMs: number
  rawBytes: number
  modelBytes: number
  truncated: boolean
  recordedAt: number
  /** ArtifactStore ID — set when artifactStore was active during the original read.
   * Lets the dedup path tell the model how to recover the full content via read_section
   * even if stale-round compaction has truncated the prior tool_result. */
  artifactId?: string
}
const readHistory = new Map<string, ReadHistoryEntry>()
const READ_HISTORY_MAX = 500

function readHistoryKey(cwd: string, canonicalPath: string, offset: number, limit: number | undefined): string {
  return `${cwd}::${canonicalPath}::${offset}::${limit ?? 'all'}`
}

function trimReadHistory(): void {
  if (readHistory.size <= READ_HISTORY_MAX) return
  const sorted = [...readHistory.entries()].sort((a, b) => a[1].recordedAt - b[1].recordedAt)
  const drop = Math.ceil(readHistory.size * 0.2)
  for (let i = 0; i < drop; i++) readHistory.delete(sorted[i]![0])
}

/** Test-only: clear dedup state between unit tests. */
export function __resetReadHistoryForTests(): void {
  readHistory.clear()
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
- Files up to ~50,000 lines are returned in full — DO NOT split them yourself by writing temp files and reading slices, just call read_file once
- Use offset and limit ONLY when you specifically need a known sub-range (e.g. a function at line 800-900); never as a workaround for "the file might be too long"
- This tool can read text files, images (PNG/JPG), and PDF files
- Do NOT re-read a file that you already read in the current session unless you have edited it since — your earlier tool_result is still in context

### Examples
Good: read_file(file_path="/abs/path/src/app.ts")  → returns the whole file
Good: read_file(file_path="/abs/path/src/app.ts", offset=100, limit=50)  → only when you know you want lines 100-150
Bad:  read_file(file_path="src/app.ts")  → relative path
Bad:  splitting a file into 6 temp files via write_file and reading them back  → wasteful, just call read_file once
Bad:  re-reading the same file you already read this session  → look at your previous tool_result instead`,
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
    const computedCap = computeModelReadCap({
      contextWindow: params.contextWindow,
      providerProfile: params.providerProfile,
    })

    // P5+P6 follow-up: dedup repeat reads of the same unchanged file.
    // Resolve canonical path + mtime BEFORE invoking readFilePayload so we can
    // short-circuit without doing the full read.
    const filePath = params.input.file_path as string
    const offset = (params.input.offset as number) ?? 1
    const limit = params.input.limit as number | undefined
    let dedupKey: string | null = null
    let currentMtimeMs: number | null = null
    try {
      const canonical = validatePath(params.cwd, filePath)
      if (existsSync(canonical)) {
        currentMtimeMs = statSync(canonical).mtimeMs
        dedupKey = readHistoryKey(params.cwd, canonical, offset, limit)
        const prior = readHistory.get(dedupKey)
        if (prior && prior.mtimeMs === currentMtimeMs && prior.artifactId) {
          // Already read this exact slice; file hasn't changed since.
          // eslint-disable-next-line no-console
          console.warn(`[read-dedup] skip file=${canonical} offset=${offset} limit=${limit ?? 'all'} prior_age_ms=${Date.now() - prior.recordedAt}`)
          const recoveryHint = prior.artifactId
            ? `If you can no longer see the earlier result (it may have been compacted to a summary), call read_section(artifactId="${prior.artifactId}", section="L1-L500") to retrieve it from disk.`
            : `Look at the earlier tool_result in your context.`
          const message = [
            `read_file: this exact range was already returned earlier in the conversation and the file has not been modified since.`,
            `  file: ${canonical}`,
            `  offset: ${offset}, limit: ${limit ?? 'all'}`,
            `  prior result: ${prior.rawBytes} bytes raw${prior.truncated ? ` (model saw ${prior.modelBytes})` : ''}`,
            ``,
            recoveryHint,
            `Do NOT call read_file again with the same args — it will be deduped again.`,
            `If you need a different slice, change offset/limit. If you suspect the file changed, edit it first or read a different file.`,
          ].join('\n')
          return { content: message }
        }
      }
    } catch { /* fall through to real read; e.g. invalid path → let readFilePayload error normally */ }

    try {
      payload = readFilePayload(params.cwd, {
        filePath,
        offset,
        limit,
        modelCap: computedCap,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }

    // P0-2 trace: verify read_file returns full content, not truncated
    // eslint-disable-next-line no-console
    console.warn(`[read-cap] file=${payload.canonicalPath} raw=${payload.rawContent.length} model=${payload.modelContent.length} truncated=${payload.rawContent.length !== payload.modelContent.length} cap=${computedCap.maxChars} ctxWindow=${params.contextWindow ?? 'undefined'}`)

    const rawPath = await persistRawOutput(params.toolUseId, payload.rawContent)

    // Helper to write the dedup entry once we know whether an artifact was created.
    const recordDedup = (artifactId?: string): void => {
      if (!dedupKey || currentMtimeMs === null) return
      readHistory.set(dedupKey, {
        mtimeMs: currentMtimeMs,
        rawBytes: payload.rawContent.length,
        modelBytes: payload.modelContent.length,
        truncated: payload.rawContent.length !== payload.modelContent.length,
        recordedAt: Date.now(),
        artifactId,
      })
      trimReadHistory()
    }

    if (params.artifactStore) {
      // Skip artifact wrapping for content small enough that prune won't touch it.
      // Why: every [artifact:X] reference is a "your content might be hidden"
      // signal that the model treats as truncation. If the raw content is below
      // pruneThresholds.minChars, prune will never replace it with a placeholder,
      // so the artifact backup serves no purpose — and its presence makes the
      // model second-guess what it can see. Tianshu's post-mortem showed this
      // exact pattern: any [artifact:X] marker triggered "let me try a different
      // approach" workarounds even when the content was right there.
      const { minChars: artifactThreshold } = pruneThresholds(params.contextWindow ?? 0)
      const wrapInArtifact = payload.rawContent.length >= artifactThreshold

      if (!wrapInArtifact) {
        // eslint-disable-next-line no-console
        console.warn(`[artifact-skip] tool=read_file file=${payload.canonicalPath} raw=${payload.rawContent.length} threshold=${artifactThreshold}`)
        recordDedup()
        return {
          content: payload.modelContent,
          uiContent: payload.uiContent,
          rawPath,
        }
      }

      // eslint-disable-next-line no-console
      console.warn(`[artifact-wrap] tool=read_file file=${payload.canonicalPath} raw=${payload.rawContent.length} threshold=${artifactThreshold}`)
      const { summary, sections } = summarizeFileContent(payload.rawContent, payload.canonicalPath)
      const artifactId = await params.artifactStore.save({
        tool: 'read_file',
        target: payload.canonicalPath,
        rawContent: payload.rawContent,
        summary,
        sections,
      })
      recordDedup(artifactId)
      // MODEL SEES FULL CODE — not just structural summary
      // Agent needs actual source to construct edit_file old_string
      const summaryBlock = summary.trim()
        ? `\n\n── Structural outline ──\n${summary.trim()}`
        : ''
      // Convention: [artifact:X] is always the LAST token in the content string.
      // prune.ts and stale-round.ts regex `/\[artifact:([A-Za-z0-9_-]+)]\s*$/`
      // depend on this position; any suffix (instructions, summary) goes BEFORE it.
      return {
        content: payload.modelContent + summaryBlock + `\n[artifact:${artifactId}]`,
        rawContent: payload.modelContent,
        uiContent: payload.uiContent,
        rawPath,
      }
    }

    // No artifact store — record dedup without an artifactId.
    recordDedup()
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
