import { existsSync } from 'fs'
import { stat, readFile } from 'node:fs/promises'
import { extname } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'
import { persistRawOutput } from './output-store.js'
import { summarizeFileContent } from '../artifact/summarize.js'
import { computeModelReadCap, DEFAULT_MODEL_READ_CAP, type ModelReadCap } from './model-read-cap.js'
import { pruneThresholds } from '../compact/constants.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { decideReadPolicy } from './read-policy.js'

// Cache GitignoreFilter instances by cwd to avoid re-reading .gitignore on every call
const gitignoreCache = new Map<string, { filter: Promise<GitignoreFilter>; ts: number }>()
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

/** File-level dedup: records full-file reads so fragment reads can be
 * blocked without re-reading. Key = canonicalPath, no offset/limit.
 * Independent of readHistory (per-slice dedup). */
interface FileReadHistoryEntry {
  mtimeMs: number
  totalLines: number
  rawBytes: number
  modelBytes: number
  artifactId?: string
  recordedAt: number
}
const fileReadHistory = new Map<string, FileReadHistoryEntry>()
const FILE_READ_HISTORY_MAX = 200

function readHistoryKey(cwd: string, canonicalPath: string, offset: number, limit: number | undefined): string {
  return `${cwd}::${canonicalPath}::${offset}::${limit ?? 'all'}`
}

function trimReadHistory(): void {
  if (readHistory.size <= READ_HISTORY_MAX) return
  const sorted = [...readHistory.entries()].sort((a, b) => a[1].recordedAt - b[1].recordedAt)
  const drop = Math.ceil(readHistory.size * 0.2)
  for (let i = 0; i < drop; i++) readHistory.delete(sorted[i]![0])
}

function trimFileReadHistory(): void {
  if (fileReadHistory.size <= FILE_READ_HISTORY_MAX) return
  const sorted = [...fileReadHistory.entries()].sort((a, b) => a[1].recordedAt - b[1].recordedAt)
  const drop = Math.ceil(fileReadHistory.size * 0.2)
  for (let i = 0; i < drop; i++) fileReadHistory.delete(sorted[i]![0])
}

/** Test-only: clear dedup state between unit tests. */
export function __resetReadHistoryForTests(): void {
  readHistory.clear()
  fileReadHistory.clear()
}

/** Return the last known mtimeMs for a file from the read history, or null if never read. */
export function getFileReadMtime(canonicalPath: string): number | null {
  const entry = fileReadHistory.get(canonicalPath)
  return entry ? entry.mtimeMs : null
}

/** Refresh the mtime cache for a file after stale detection.
 *  This prevents a read-edit-stale loop: after edit_file detects a stale file,
 *  it updates the cache so the next edit attempt (after the model re-reads)
 *  won't immediately fail again. Returns the new mtimeMs or null. */
export function refreshFileReadMtime(canonicalPath: string, newMtimeMs: number): void {
  const entry = fileReadHistory.get(canonicalPath)
  if (entry) {
    entry.mtimeMs = newMtimeMs
  }
}

/** Test-only: inject a file read history entry so stale detection can trigger
 *  without needing to call read_file first. */
export function __setFileReadMtimeForTests(canonicalPath: string, mtimeMs: number): void {
  fileReadHistory.set(canonicalPath, {
    mtimeMs,
    totalLines: 0,
    rawBytes: 0,
    modelBytes: 0,
    recordedAt: Date.now(),
  })
}

async function sliceFromArtifact(
  store: { readRaw(id: string): Promise<string | null> },
  artifactId: string,
  offset: number,
  limit: number | undefined,
): Promise<string | null> {
  const recovered = await store.readRaw(artifactId)
  if (!recovered) return null
  const lines = recovered.split('\n')
  const start = Math.max(0, offset - 1)
  const end = limit ? start + limit : lines.length
  return lines.slice(start, end).join('\n')
}

function getGitignoreFilter(cwd: string): Promise<GitignoreFilter> {
  const cached = gitignoreCache.get(cwd)
  if (cached && Date.now() - cached.ts < GITIGNORE_CACHE_TTL) {
    return cached.filter
  }
  const filterPromise = GitignoreFilter.create(cwd)
  gitignoreCache.set(cwd, { filter: filterPromise, ts: Date.now() })
  trimGitignoreCache()
  return filterPromise
}

const MAX_TOOL_INPUT_BYTES = 100 * 1024
const LOG_PREVIEW_LINES = 80

/** File extensions known to be binary — read_file rejects them with a clear error
 *  instead of returning garbled UTF-8 to the model. */
const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.bmp', '.ico', '.webp', '.svgz',
  '.pdf',
  '.exe', '.dll', '.so', '.dylib', '.wasm',
  '.zip', '.tar', '.gz', '.bz2', '.xz', '.7z', '.rar',
  '.mp3', '.mp4', '.avi', '.mov', '.wav', '.ogg', '.flac',
  '.woff', '.woff2', '.ttf', '.otf', '.eot',
  '.pyc', '.class', '.o', '.obj',
  '.db', '.sqlite', '.sqlite3',
])

function buildLogPreviewContent(filePath: string, content: string): string {
  const lines = content.split('\n')
  const headCount = Math.min(LOG_PREVIEW_LINES, lines.length)
  const tailCount = Math.min(LOG_PREVIEW_LINES, Math.max(0, lines.length - headCount))
  const head = lines.slice(0, headCount)
  const tail = tailCount > 0 ? lines.slice(-tailCount) : []
  const omitted = Math.max(0, lines.length - head.length - tail.length)
  const tailStart = tail.length > 0 ? lines.length - tail.length + 1 : 1
  const parts = [
    `read_file: ${filePath} looks like a log/JSONL output file (${content.length} chars, ${lines.length} lines).`,
    `Full first reads of log files waste context; returning a bounded preview only.`,
    `Preview boundaries: head offset=1 limit=${head.length}${tail.length > 0 ? `; tail offset=${tailStart} limit=${tail.length}` : ''}.`,
    `Next step: use read_file(file_path=..., offset=<known line>, limit<=200) for a specific range; use grep on this file for keywords/timestamps before reading middle ranges. Do not scan the whole project for this log.`,
    '',
    `── head (L1-L${head.length}) ──`,
    ...head,
  ]
  if (omitted > 0) {
    parts.push('', `... ${omitted} lines omitted ...`, '', `── tail (L${tailStart}-L${lines.length}) ──`, ...tail)
  }
  return parts.join('\n')
}

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
export async function readFilePayload(cwd: string, options: ReadFilePayloadOptions): Promise<ReadFilePayload> {
  const filePath = validatePath(cwd, options.filePath)
  let fileStat: Awaited<ReturnType<typeof stat>>
  try {
    fileStat = await stat(filePath)
  } catch {
    throw new Error(`File not found: ${filePath}`)
  }

  const filter = await getGitignoreFilter(cwd)
  if (filter.isIgnored(cwd, filePath)) {
    throw new Error(`File is gitignored (node_modules, build artifacts, etc.): ${filePath}`)
  }

  // Reject binary files with a clear error — the tool description promises this.
  // Common binary extensions are checked before reading to avoid returning garbled UTF-8.
  const ext = extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`File is binary (${ext} format). read_file only reads text files. Use file_info to inspect metadata.`)
  }

  const fileSize = fileStat.size
  const hasExplicitRange = options.offset !== undefined || options.limit !== undefined
  const policy = decideReadPolicy({ filePath, sizeBytes: fileSize, hasExplicitRange })

  if (fileSize > MAX_TOOL_INPUT_BYTES && !hasExplicitRange) {
    const sizeKB = (fileSize / 1024).toFixed(0)
    const estLines = Math.ceil(fileSize / 80)
    throw new Error(
      `File too large (${sizeKB}KB, ~${estLines} lines). Use offset and limit to read specific ranges.`
    )
  }

  let content = await readFile(filePath, 'utf-8')
  const offset = options.offset ?? 1
  const limit = options.limit
  const cap = options.modelCap ?? DEFAULT_MODEL_READ_CAP

  if (policy.action === 'reject-with-range' && !hasExplicitRange) {
    throw new Error(`${policy.reason}. Use offset and limit to read a specific range.`)
  }

  if (policy.action === 'preview' && !hasExplicitRange) {
    const preview = buildLogPreviewContent(filePath, content)
    return {
      canonicalPath: filePath,
      rawContent: content,
      modelContent: truncateContent(preview, cap.maxChars, cap.headChars, cap.tailChars),
      uiContent: buildFileUiOutput(content, 80),
    }
  }

  if (offset > 1 || limit) {
    const lines = content.split('\n')
    const startIdx = offset - 1
    if (startIdx >= lines.length) {
      return {
        canonicalPath: filePath,
        rawContent: `Error: offset ${offset} exceeds file length (${lines.length} lines)`,
        modelContent: `Error: offset ${offset} exceeds file length (${lines.length} lines). File has ${lines.length} lines. Re-read without offset or use a smaller offset value.`,
        uiContent: '',
      }
    }
    if (offset < 1) {
      return {
        canonicalPath: filePath,
        rawContent: `Error: offset must be >= 1 (got ${offset})`,
        modelContent: `Error: offset must be >= 1 (got ${offset}). Lines are 1-based.`,
        uiContent: '',
      }
    }
    const endIdx = limit ? startIdx + limit : undefined
    content = lines.slice(startIdx, endIdx).join('\n')
  }

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
- This tool reads text files only (UTF-8). Binary files (images, PDFs, executables) will be rejected
- Do NOT re-read a file that you already read in the current session unless you have edited it since — your earlier tool_result is still in context

### Examples
Good: read_file(file_path="/abs/path/src/app.ts")  → returns the whole file
Good: read_file(file_path="/abs/path/src/app.ts", offset=100, limit=50)  → only when you know you want lines 100-150
Good: read_file(file_paths=["/abs/a.ts", "/abs/b.ts"])  → read multiple files in one call (saves turns)
Bad:  read_file(file_path="src/app.ts")  → relative path
Bad:  splitting a file into 6 temp files via write_file and reading them back  → wasteful, just call read_file once
Bad:  re-reading the same file you already read this session  → look at your previous tool_result instead`,
    input_schema: {
      type: 'object',
      properties: {
        file_path: { type: 'string', description: 'Absolute path to the file' },
        file_paths: {
          type: 'array',
          items: { type: 'string' },
          description: 'Read multiple files in one call. Use instead of repeated read_file calls. Each file gets its own section. Max 5 files.',
        },

        offset: { type: 'integer', description: 'Line number to start reading from (1-based)' },
        limit: { type: 'integer', description: 'Maximum number of lines to read' },
      },
      required: ['file_path'],
    },
  },

  async execute(params: ToolCallParams) {
    // Multi-read branch: file_paths array
    const filePaths = params.input.file_paths as string[] | undefined
    if (filePaths && filePaths.length > 0) {
      return await handleMultiRead(params, filePaths.slice(0, 5))
    }

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
    let canonical: string | null = null
    try {
      canonical = validatePath(params.cwd, filePath)
      if (existsSync(canonical)) {
        currentMtimeMs = (await stat(canonical)).mtimeMs
        dedupKey = readHistoryKey(params.cwd, canonical, offset, limit)
        const prior = readHistory.get(dedupKey)
        if (prior && prior.mtimeMs === currentMtimeMs && prior.artifactId) {
          if (params.artifactStore) {
            const slice = await sliceFromArtifact(params.artifactStore, prior.artifactId, offset, limit)
            if (slice !== null) {
              debugLog(`[read-dedup] re-serve from artifact file=${canonical} offset=${offset} limit=${limit ?? 'all'}`)
              return { content: slice }
            }
          }
          debugLog(`[read-dedup] artifact unreadable, falling through to normal read file=${canonical}`)
        }
        const fullEntry = fileReadHistory.get(canonical)
        if (fullEntry && fullEntry.mtimeMs === currentMtimeMs && fullEntry.artifactId && (offset !== 1 || limit !== undefined)) {
          if (params.artifactStore) {
            const slice = await sliceFromArtifact(params.artifactStore, fullEntry.artifactId, offset, limit)
            if (slice !== null) {
              debugLog(`[read-dedup-file] re-serve slice from artifact file=${canonical} offset=${offset} limit=${limit ?? 'all'}`)
              return { content: slice }
            }
          }
          debugLog(`[read-dedup-file] artifact unreadable, falling through file=${canonical}`)
        }
      }
    } catch { /* fall through to real read; e.g. invalid path → let readFilePayload error normally */ }

    try {
      payload = await readFilePayload(params.cwd, {
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
    debugLog(`[read-cap] file=${payload.canonicalPath} raw=${payload.rawContent.length} model=${payload.modelContent.length} truncated=${payload.rawContent.length !== payload.modelContent.length} cap=${computedCap.maxChars} ctxWindow=${params.contextWindow ?? 'undefined'}`)

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

    // Record file-level dedup entry for full-file reads.
    const recordFileDedup = (artifactId?: string): void => {
      if (!canonical || currentMtimeMs === null) return
      if (offset !== 1 || limit !== undefined) return // only full reads
      fileReadHistory.set(canonical, {
        mtimeMs: currentMtimeMs,
        totalLines: payload.rawContent.split('\n').length,
        rawBytes: payload.rawContent.length,
        modelBytes: payload.modelContent.length,
        artifactId,
        recordedAt: Date.now(),
      })
      trimFileReadHistory()
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
      const artifactThreshold = getToolArtifactThreshold('read_file', params.contextWindow)
      const wrapInArtifact = payload.rawContent.length >= artifactThreshold

      if (!wrapInArtifact) {
        debugLog(`[artifact-skip] tool=read_file file=${payload.canonicalPath} raw=${payload.rawContent.length} threshold=${artifactThreshold}`)
        recordDedup()
        recordFileDedup()
        return {
          content: payload.modelContent,
          uiContent: payload.uiContent,
          rawPath,
        }
      }

      debugLog(`[artifact-wrap] tool=read_file file=${payload.canonicalPath} raw=${payload.rawContent.length} threshold=${artifactThreshold}`)
      const { summary, sections } = summarizeFileContent(payload.rawContent, payload.canonicalPath)
      const artifactId = await params.artifactStore.save({
        tool: 'read_file',
        target: payload.canonicalPath,
        rawContent: payload.rawContent,
        summary,
        sections,
      })
      recordDedup(artifactId)
      recordFileDedup(artifactId)
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
    recordFileDedup()
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

/** Handle multi-file read: file_paths array. Reads up to 5 files, each with
 *  an independent per-file budget derived from the overall model read cap. */
async function handleMultiRead(params: ToolCallParams, paths: string[]): Promise<import('./types.js').ToolResult> {
  const computedCap = computeModelReadCap({
    contextWindow: params.contextWindow,
    providerProfile: params.providerProfile,
  })
  const perFileCap: ModelReadCap = {
    maxChars: Math.floor(computedCap.maxChars / paths.length),
    headChars: Math.floor(computedCap.headChars / paths.length),
    tailChars: Math.floor(computedCap.tailChars / paths.length),
  }

  const sections: string[] = []
  let totalBytes = 0
  let errors = 0

  for (const rawPath of paths) {
    const trimmed = rawPath.trim()
    if (!trimmed) continue
    try {
      const payload = await readFilePayload(params.cwd, { filePath: trimmed, modelCap: perFileCap })
      const relPath = payload.canonicalPath.replace(params.cwd + '/', '')
      sections.push(`── ${relPath} ──\n${payload.modelContent}`)
      totalBytes += payload.rawContent.length

      // Record file-level dedup for each file
      const currentMtimeMs = (await stat(payload.canonicalPath)).mtimeMs
      fileReadHistory.set(payload.canonicalPath, {
        mtimeMs: currentMtimeMs,
        totalLines: payload.rawContent.split('\n').length,
        rawBytes: payload.rawContent.length,
        modelBytes: payload.modelContent.length,
        recordedAt: Date.now(),
      })
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const display = trimmed.replace(params.cwd + '/', '')
      sections.push(`── ${display} ──\nError: ${msg}`)
      errors++
    }
  }
  trimFileReadHistory()

  const content = sections.join('\n\n')
  return {
    content,
    uiContent: `Read ${paths.length - errors}/${paths.length} files (${(totalBytes / 1024).toFixed(1)} KB total)`,
  }
}

