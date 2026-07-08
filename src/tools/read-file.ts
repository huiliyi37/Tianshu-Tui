import { existsSync } from 'fs'
import { stat, readFile } from 'node:fs/promises'
import { extname, relative } from 'path'
import type { Tool, ToolCallParams } from './types.js'
import { truncateContent, buildPartialView } from './truncation.js'
import { validatePath } from './path-validate.js'
import { GitignoreFilter } from './gitignore.js'
import { persistRawOutput } from './output-store.js'
import { summarizeFileContent } from '../artifact/summarize.js'
import { computeModelReadCap, DEFAULT_MODEL_READ_CAP, type ModelReadCap } from './model-read-cap.js'
import { getToolArtifactThreshold } from './artifact-threshold.js'
import { debugLog } from '../utils/debug.js'
import { decideReadPolicy } from './read-policy.js'
import { foldCode } from '../compact/code-fold.js'
import { canUsePrewarmForRead, consumePrewarm } from '../agent/prewarm-file.js'
import { canonicalPathKey } from '../path-format.js'
import { OFFICE_EXTENSIONS, readOfficeFile } from './office-reader.js'

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
// burning tokens by repeatedly reading the same unchanged file. Entries record
// the file's mtime AND size at read time so an external edit (or our own
// write_file/edit_file) auto-invalidates; our own edits additionally delete
// entries eagerly via invalidateReadHistory().
interface ReadHistoryEntry {
  mtimeMs: number
  /** stat().size of the whole file at read time — second staleness signal
   *  alongside mtime, hardening against coarse-mtime filesystems (exFAT: 2s). */
  sizeBytes: number
  rawBytes: number
  modelBytes: number
  truncated: boolean
  recordedAt: number
  /** ArtifactStore ID — set when artifactStore was active during the original read.
   * Lets the dedup path tell the model how to recover the full content via read_section
   * even if stale-round compaction has truncated the prior tool_result. */
  artifactId?: string
  /** Times a [read-ref] shortcut was served against this entry. When the model
   *  comes back for the SAME unchanged slice after already receiving a ref, the
   *  ref demonstrably didn't help (its "look above" target may have been pruned
   *  from the request view) — degrade to a real read instead of looping. */
  refServed?: number
}
const readHistory = new Map<string, ReadHistoryEntry>()
const READ_HISTORY_MAX = 500

/** File-level dedup: records full-file reads so fragment reads can be
 * blocked without re-reading. Key = fileHistoryKey(sessionId, canonicalPath),
 * no offset/limit. Independent of readHistory (per-slice dedup). */
interface FileReadHistoryEntry {
  mtimeMs: number
  /** stat().size at read time — see ReadHistoryEntry.sizeBytes. */
  sizeBytes: number
  totalLines: number
  rawBytes: number
  modelBytes: number
  artifactId?: string
  recordedAt: number
  /** See ReadHistoryEntry.refServed. */
  refServed?: number
}
const fileReadHistory = new Map<string, FileReadHistoryEntry>()
const FILE_READ_HISTORY_MAX = 200

/** 表2 — last observed file state per session. Written by read_file, grep
 *  registration, AND successful edits (edit_file/hash_edit/write_file). Read
 *  by the stale-file detection in the edit tools and read_section.
 *
 *  This is deliberately separate from readHistory/fileReadHistory (表1): 表1
 *  means "content the model actually read" and is only ever written by read
 *  paths — edits DELETE its entries (invalidateReadHistory) so read-ref can
 *  never claim "unchanged" against pre-edit content. 表2 carries the old
 *  refreshFileReadMtime duty: after our own successful edit we note the new
 *  mtime here so the next edit's staleness check doesn't false-positive on
 *  our own write (read-edit-stale loop prevention). */
interface KnownFileState {
  mtimeMs: number
  sizeBytes: number
}
const lastKnownFileState = new Map<string, KnownFileState>()
const LAST_KNOWN_MAX = 500

/** Consecutive edit_file "old_string not found" failures per file.
 *  ≥3 triggers a hard gate requiring read_file before further edits. */
const editFailCount = new Map<string, number>()

export function incrementEditFailCount(canonicalPath: string): number {
  const n = (editFailCount.get(canonicalPath) ?? 0) + 1
  editFailCount.set(canonicalPath, n)
  return n
}

export function resetEditFailCount(canonicalPath: string): void {
  editFailCount.delete(canonicalPath)
}

export function __resetEditFailCountForTests(): void {
  editFailCount.clear()
}

function trimLastKnown(): void {
  if (lastKnownFileState.size <= LAST_KNOWN_MAX) return
  const drop = Math.ceil(lastKnownFileState.size * 0.2)
  let i = 0
  for (const key of lastKnownFileState.keys()) {
    lastKnownFileState.delete(key)
    if (++i >= drop) break
  }
}

/** When enabled, repeated reads of unchanged files return a compact reference
 *  instead of re-emitting the full content. Default-on (opt-out with RIVET_READ_REF=0).
 *  Checked at call time (not module load) so tests can toggle dynamically. */
function isReadRefEnabled(): boolean {
  return process.env['RIVET_READ_REF'] !== '0'
}

/** Minimum modelContent bytes for read-ref to apply. Smaller repeats stay
 *  as direct content to avoid wasted round-trips for tiny fragments. */
const READ_REF_THRESHOLD = 2048

/** Per-session read-ref telemetry accumulator. When injected via ToolCallParams,
 *  read-ref stats scope to the session instead of accumulating process-wide. */
export interface ReadRefStats {
  savedBytes: number
  count: number
}

/** Telemetry: cumulative bytes saved via read-ref (avoided cacheCreate).
 *  Module-level fallback used when no per-session accumulator is injected. */
let readRefSavedBytes = 0
/** Telemetry: number of read-ref shortcuts executed. Module-level fallback. */
let readRefCount = 0

/** Session-level file edit tracking: records which files this session has
 *  successfully written to. Used by staleness detection to disambiguate
 *  "modified externally" from "you edited this yourself earlier."
 *  Keyed by `${sessionId ?? ''}::${path}` so concurrent in-process sessions
 *  (fork/worker) don't see each other's edit marks.
 *  Intentionally NOT cleared on compaction — the agent should always know
 *  which files it has touched, even after long sessions. */
const sessionFileEdits = new Set<string>()

/** Mark a file as having been written by this session. Call after any
 *  successful write (edit_file, hash_edit, write_file, apply_patch). */
export function markSessionFileEdit(canonicalPath: string, sessionId?: string): void {
  sessionFileEdits.add(fileHistoryKey(sessionId, canonicalPath))
}

/** Check whether this session has previously written to this file. */
export function wasFileEditedBySession(canonicalPath: string, sessionId?: string): boolean {
  return sessionFileEdits.has(fileHistoryKey(sessionId, canonicalPath))
}

/** Test-only: reset session edit tracking between unit tests. */
export function __resetSessionFileEditsForTests(): void {
  sessionFileEdits.clear()
}
// 键路径统一走 canonicalPathKey（win32 下分隔符归一 + lowercase）：Windows 上
// D:\a / D:/a / d:/a 是同一文件，字符串键却是三个——读表漏命中事小，编辑后
// invalidateReadHistory 的后缀匹配失手 → read-ref 拿旧内容说"未变"才是要害。
function readHistoryKey(cwd: string, canonicalPath: string, offset: number, limit: number | undefined, sessionId?: string): string {
  return `${sessionId ?? ''}::${canonicalPathKey(cwd)}::${canonicalPathKey(canonicalPath)}::${offset}::${limit ?? 'all'}`
}

/** Key for fileReadHistory / lastKnownFileState / sessionFileEdits — scoped by
 *  sessionId so concurrent sessions in the same cwd (fork/worker) don't see
 *  each other's "already read"/"already edited" state. */
function fileHistoryKey(sessionId: string | undefined, canonicalPath: string): string {
  return `${sessionId ?? ''}::${canonicalPathKey(canonicalPath)}`
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

/**
 * Returns true when a prior read of the same file (same offset/limit, or a full-file
 * read that subsumes this request) was recorded with a matching mtime AND size —
 * meaning the file has NOT been modified since it was last read.
 */
export function isUnchangedRepeatRead(
  canonical: string,
  currentMtimeMs: number,
  currentSizeBytes: number,
  dedupKey: string,
  offset: number,
  limit: number | undefined,
  sessionId?: string,
): boolean {
  const priorSame = readHistory.get(dedupKey)
  if (priorSame && priorSame.mtimeMs === currentMtimeMs && priorSame.sizeBytes === currentSizeBytes) return true
  const fullPrior = fileReadHistory.get(fileHistoryKey(sessionId, canonical))
  if (fullPrior && fullPrior.mtimeMs === currentMtimeMs && fullPrior.sizeBytes === currentSizeBytes && offset === 1 && !limit) return true
  return false
}

/** Test-only: clear dedup state between unit tests. */
export function __resetReadHistoryForTests(): void {
  readHistory.clear()
  fileReadHistory.clear()
  lastKnownFileState.clear()
  sessionFileEdits.clear()
  readRefSavedBytes = 0
  readRefCount = 0
}

/** Return the last mtimeMs this session observed for a file (via read_file,
 *  grep, or its own successful edit), or null if never observed. */
export function getFileReadMtime(canonicalPath: string, sessionId?: string): number | null {
  const entry = lastKnownFileState.get(fileHistoryKey(sessionId, canonicalPath))
  return entry ? entry.mtimeMs : null
}

/** Record the file state this session just observed (read or wrote).
 *  Successor of the old refreshFileReadMtime: after a successful edit the
 *  caller notes the post-write mtime here so the NEXT edit's staleness check
 *  doesn't false-positive on our own write (read-edit-stale loop prevention).
 *  Writes 表2 only — never touches the read-dedup tables, so read-ref can
 *  never be tricked into claiming pre-edit content is current. */
export function noteFileObserved(canonicalPath: string, mtimeMs: number, sizeBytes: number, sessionId?: string): void {
  lastKnownFileState.set(fileHistoryKey(sessionId, canonicalPath), { mtimeMs, sizeBytes })
  trimLastKnown()
}

/** Drop every read-dedup record (all sessions) for a canonical path. Called
 *  after a successful edit_file/hash_edit/write_file: the on-disk content no
 *  longer matches what any session read, so "already read and unchanged"
 *  claims and artifact-backed slices for this path must die. Cross-session
 *  deletion is safe — those entries would fail the mtime+size check anyway. */
export function invalidateReadHistory(canonicalPath: string): void {
  // canonicalPathKey 归一后再匹配：跨会话 file_changed 事件带来的路径可能与
  // 本进程建键时的大小写/分隔符不同（另一进程、另一种 shell），不归一会静默
  // 失效——正是 Windows 上 read-ref 中毒的复发通道。
  const keyPath = canonicalPathKey(canonicalPath)
  const suffix = `::${keyPath}`
  for (const key of fileReadHistory.keys()) {
    if (key.endsWith(suffix)) fileReadHistory.delete(key)
  }
  // readHistory keys embed offset/limit after the path: match the path segment.
  const segment = `::${keyPath}::`
  for (const key of readHistory.keys()) {
    if (key.includes(segment)) readHistory.delete(key)
  }
}

/** Drop ALL read-dedup records (表1) for a session. Called after any message-
 *  history rewrite (compaction ladder, agent-diet, stale-round, heap micro-
 *  compact): the historical tool_results that read-ref points at ("回看上文")
 *  may have been deleted, summarized, or replaced with placeholders, so
 *  "already read" claims must die with them. 表2 (lastKnownFileState) and
 *  sessionFileEdits survive — they track FILE state, not history presence.
 *  Cost ceiling: one extra real read per file after a compaction that already
 *  rewrote history (prefix cache is broken at that point anyway). */
export function invalidateSessionReadDedup(sessionId?: string): void {
  const prefix = `${sessionId ?? ''}::`
  for (const key of readHistory.keys()) {
    if (key.startsWith(prefix)) readHistory.delete(key)
  }
  for (const key of fileReadHistory.keys()) {
    if (key.startsWith(prefix)) fileReadHistory.delete(key)
  }
}

/** One-stop bookkeeping after a successful write (edit_file/hash_edit/
 *  write_file): drop every read-dedup record for the path (its content is no
 *  longer what any session read), note the post-write file state so the next
 *  edit's staleness check doesn't false-positive on our own write, and mark
 *  the file as session-edited. */
export async function recordSuccessfulEdit(canonicalPath: string, sessionId?: string): Promise<void> {
  invalidateReadHistory(canonicalPath)
  markSessionFileEdit(canonicalPath, sessionId)
  try {
    const s = await stat(canonicalPath)
    noteFileObserved(canonicalPath, s.mtimeMs, s.size, sessionId)
  } catch { /* file vanished between write and stat — nothing to note */ }
}

/** Test-only: inject a last-known file state so stale detection can trigger
 *  without needing to call read_file first. */
export function __setFileReadMtimeForTests(canonicalPath: string, mtimeMs: number, sessionId?: string): void {
  lastKnownFileState.set(fileHistoryKey(sessionId, canonicalPath), { mtimeMs, sizeBytes: -1 })
}

/** Test-only: evict a single 表2 entry — simulates LAST_KNOWN_MAX trimming
 *  diverging from the dedup tables (表1), which trim independently. */
export function __evictLastKnownForTests(canonicalPath: string, sessionId?: string): void {
  lastKnownFileState.delete(fileHistoryKey(sessionId, canonicalPath))
}

/**
 * Register a file as "seen" via grep (or other non-read_file tool).
 * This allows hash_edit's position-only mode to succeed after grep
 * without requiring a full read_file call.
 *
 * Only registers if the file has NOT been observed before (avoids overwriting
 * a more precise entry from read_file or an edit).
 */
export function registerGrepFileAccess(canonicalPath: string, mtimeMs: number, sessionId?: string): void {
  const key = fileHistoryKey(sessionId, canonicalPath)
  if (lastKnownFileState.has(key)) return
  lastKnownFileState.set(key, { mtimeMs, sizeBytes: -1 })
  trimLastKnown()
}

/** Return cumulative read-ref telemetry for cacheCreate cost analysis (B4). */
export function getReadRefStats(): { savedBytes: number; count: number } {
  return { savedBytes: readRefSavedBytes, count: readRefCount }
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

/**
 * Fold code into a signature skeleton, then apply byte-level partial view truncation.
 * If folding doesn't help (unknown lang, short file, or <30% reduction), fall back
 * to the original content's partial view.
 */
function applyFoldThenPartial(content: string, filePath: string, cap: ModelReadCap): string {
  const fold = foldCode(content, { filePath, maxLines: 200 })
  if (fold.wasFolded && fold.foldedLines < fold.originalLines * 0.7) {
    return buildPartialView(fold.folded, filePath, cap.maxChars)
  }
  return buildPartialView(content, filePath, cap.maxChars)
}

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
  /**
   * Full file content already read by a higher layer (e.g. a prewarm cache
   * hit), skipping the `fs.readFile` inside this function. The content must be
   * the verbatim file bytes (same as `await readFile(filePath, 'utf-8')` would
   * return) — path validation, gitignore, binary, and cap truncation still run.
   */
  prefetchedContent?: string
}

export interface ReadFilePayload {
  canonicalPath: string
  rawContent: string
  modelContent: string
  uiContent: string
}

/**
 * The agent's own state dir (`<cwd>/.rivet/`) is exempt from the gitignore
 * read block. Plan drafts (`.rivet/plans/draft-*.md`) are intentionally
 * gitignored, but plan mode makes the draft the ONLY writable file — blocking
 * reads on it deadlocks revision (session 91840816: write ok → submit
 * rejected → read back refused → wedged). The gitignore block exists to keep
 * node_modules/build junk out, not the agent's own working files.
 */
function isRivetStatePath(cwd: string, filePath: string): boolean {
  const norm = (p: string) => p.replace(/\\/g, '/').replace(/\/+$/, '')
  return norm(filePath).startsWith(`${norm(cwd)}/.rivet/`)
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
  if (filter.isIgnored(cwd, filePath) && !isRivetStatePath(cwd, filePath)) {
    throw new Error(`File is gitignored (node_modules, build artifacts, etc.): ${filePath}`)
  }

  // Reject binary files with a clear error — the tool description promises this.
  // Common binary extensions are checked before reading to avoid returning garbled UTF-8.
  const ext = extname(filePath).toLowerCase()

  // Office documents: convert to plain text via platform-native tools
  if (OFFICE_EXTENSIONS.has(ext)) {
    const result = await readOfficeFile(filePath)
    const officeHint = `\n\n── Office document (${ext}, converted via ${result.engine}) ──`
    const cap = options.modelCap ?? DEFAULT_MODEL_READ_CAP
    return {
      canonicalPath: filePath,
      rawContent: result.text,
      modelContent: truncateContent(result.text, cap.maxChars, cap.headChars, cap.tailChars) + officeHint,
      uiContent: result.text.slice(0, 200),
    }
  }

  if (BINARY_EXTENSIONS.has(ext)) {
    throw new Error(`File is binary (${ext} format). read_file only reads text files. Use file_info to inspect metadata.`)
  }

  const fileSize = fileStat.size
  const hasExplicitRange = options.offset !== undefined || options.limit !== undefined
  const policy = decideReadPolicy({ filePath, sizeBytes: fileSize, hasExplicitRange })

  if (fileSize > MAX_TOOL_INPUT_BYTES && !hasExplicitRange) {
    if (policy.action === 'partial') {
      // Large source file: read and return PARTIAL view instead of hard error
      const content = options.prefetchedContent ?? await readFile(filePath, 'utf-8')
      const cap = options.modelCap ?? DEFAULT_MODEL_READ_CAP
      const partialContent = applyFoldThenPartial(content, filePath, cap)
      return {
        canonicalPath: filePath,
        rawContent: content,
        modelContent: partialContent,
        uiContent: buildFileUiOutput(content, 80),
      }
    }
    const sizeKB = (fileSize / 1024).toFixed(0)
    const estLines = Math.ceil(fileSize / 80)
    throw new Error(
      `File too large (${sizeKB}KB, ~${estLines} lines). Use offset and limit to read specific ranges.`
    )
  }

  let content = options.prefetchedContent ?? await readFile(filePath, 'utf-8')
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

  // PARTIAL view for source files that fit in memory but exceed the model cap
  if (policy.action === 'partial' && !hasExplicitRange) {
    const partialContent = applyFoldThenPartial(content, filePath, cap)
    return {
      canonicalPath: filePath,
      rawContent: content,
      modelContent: partialContent,
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

  // full-with-hint: append editing guidance for medium-sized files
  const modelContent = truncateContent(content, cap.maxChars, cap.headChars, cap.tailChars)
  const hint = policy.action === 'full-with-hint'
    ? `\n\n── Note: this file is ${content.split('\n').length} lines. For editing, consider: grep to locate target → hash_edit with anchors. ──`
    : ''

  return {
    canonicalPath: filePath,
    rawContent: content,
    modelContent: modelContent + hint,
    uiContent: buildFileUiOutput(content, 50),
  }
}

export const READ_FILE_TOOL: Tool = {
  definition: {
    name: 'read_file',
    description: `Read files from the filesystem with optional line range.

- Files up to ~50,000 lines returned in full — don't split them into slices yourself
- Use offset/limit only for known sub-ranges (e.g. lines 800-900), not as a workaround for long files
- Files > ~2000 lines returned as PARTIAL view with navigation hints
- Don't re-read unchanged files — prior result is still in context
- file_paths reads up to 5 files in one call`,
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
    let currentSizeBytes: number | null = null
    let canonical: string | null = null
    try {
      canonical = validatePath(params.cwd, filePath)
      if (existsSync(canonical)) {
        const currentStat = await stat(canonical)
        currentMtimeMs = currentStat.mtimeMs
        currentSizeBytes = currentStat.size
        dedupKey = readHistoryKey(params.cwd, canonical, offset, limit, params.sessionId)
        const prior = readHistory.get(dedupKey)
        if (prior && prior.mtimeMs === currentMtimeMs && prior.sizeBytes === currentSizeBytes && prior.artifactId) {
          if (params.artifactStore) {
            const slice = await sliceFromArtifact(params.artifactStore, prior.artifactId, offset, limit)
            if (slice !== null) {
              debugLog(`[read-dedup] re-serve from artifact file=${canonical} offset=${offset} limit=${limit ?? 'all'}`)
              // 表2 re-registration: dedup 表(表1) and lastKnownFileState(表2)
              // trim independently — 表2 may have evicted this entry while 表1
              // survives. Without this, "read the file first" guidance from the
              // edit/write staleness guards would loop forever (read short-
              // circuits here and never refreshes 表2). We just statted the
              // file, so the observation is current.
              noteFileObserved(canonical, currentMtimeMs, currentSizeBytes, params.sessionId)
              return { content: slice }
            }
          }
          debugLog(`[read-dedup] artifact unreadable, falling through to normal read file=${canonical}`)
        }
        const fullEntry = fileReadHistory.get(fileHistoryKey(params.sessionId, canonical))
        if (fullEntry && fullEntry.mtimeMs === currentMtimeMs && fullEntry.sizeBytes === currentSizeBytes && fullEntry.artifactId && (offset !== 1 || limit !== undefined)) {
          if (params.artifactStore) {
            const slice = await sliceFromArtifact(params.artifactStore, fullEntry.artifactId, offset, limit)
            if (slice !== null) {
              debugLog(`[read-dedup-file] re-serve slice from artifact file=${canonical} offset=${offset} limit=${limit ?? 'all'}`)
              // 表2 re-registration — same eviction-divergence reasoning as above.
              noteFileObserved(canonical, currentMtimeMs, currentSizeBytes, params.sessionId)
              return { content: slice }
            }
          }
          debugLog(`[read-dedup-file] artifact unreadable, falling through file=${canonical}`)
        }
      }
    } catch { /* fall through to real read; e.g. invalid path → let readFilePayload error normally */ }

    // ── 重复读取检测 ──
    // 检测本轮是否已读过同一文件且未变更，若是则在前端注入提醒。
    const unchangedRepeat = (canonical && currentMtimeMs !== null && currentSizeBytes !== null && dedupKey)
      ? isUnchangedRepeatRead(canonical, currentMtimeMs, currentSizeBytes, dedupKey, offset, limit, params.sessionId)
      : false

    let repeatWarning: string | null = null
    if (unchangedRepeat) {
      const priorSame = readHistory.get(dedupKey!)
      const fullPrior = fileReadHistory.get(fileHistoryKey(params.sessionId, canonical!))
      // 措辞注意：不要写「回看上文」——历史 tool_result 可能已被压缩/修剪，
      // 该指引曾诱发回看无果→再读的循环。警告总是与本次全文一起返回，
      // 直接指向随附内容即可。
      if (priorSame && priorSame.mtimeMs === currentMtimeMs) {
        repeatWarning = `\n── read-dedup ──\n⚠ 此文件本轮已读取过且未变更 (${priorSame.modelBytes} bytes, ${priorSame.truncated ? '已截断' : '完整'})。内容附在下方；后续请勿重复读取未变更的文件。\n── read-dedup ──`
      } else if (fullPrior && fullPrior.mtimeMs === currentMtimeMs && offset === 1 && !limit) {
        repeatWarning = `\n── read-dedup ──\n⚠ 此文件本轮已完整读取过且未变更 (${fullPrior.totalLines} lines, ${fullPrior.modelBytes} bytes)。内容附在下方；后续请勿重复读取未变更的文件。\n── read-dedup ──`
      }
    }

    // ── 重复读取引用化 (B2) ──
    // When RIVET_READ_REF is enabled and this is an unchanged repeat read
    // of a non-trivial file, return a compact reference instead of
    // re-emitting the full content — avoiding a cacheCreate on bytes the
    // model already has in its context.
    if (unchangedRepeat && isReadRefEnabled()) {
      const priorSame = readHistory.get(dedupKey!)
      const fullPrior = fileReadHistory.get(fileHistoryKey(params.sessionId, canonical!))
      const matchedSame = priorSame?.mtimeMs === currentMtimeMs ? priorSame : undefined
      const matchedFull = fullPrior?.mtimeMs === currentMtimeMs ? fullPrior : undefined
      const entryBytes = matchedSame ? matchedSame.modelBytes : matchedFull?.modelBytes ?? 0
      const totalLines = matchedFull ? matchedFull.totalLines : 0

      // Degrade gate: if a ref was ALREADY served for this entry and the model
      // still came back for the same unchanged slice, the ref demonstrably
      // didn't help — its "look above" target may have been pruned/masked out
      // of the request view (request-side prune never touches these tables).
      // Serve the real content instead of looping. The real read below
      // re-records fresh entries (refServed reset), so the ref gets one more
      // chance on the next repeat.
      const refAlreadyServed = Math.max(matchedSame?.refServed ?? 0, matchedFull?.refServed ?? 0) >= 1

      if (entryBytes > READ_REF_THRESHOLD && refAlreadyServed) {
        debugLog(`[read-ref-degrade] file=${canonical} ref did not help, re-serving full content`)
        repeatWarning = null
      } else if (entryBytes > READ_REF_THRESHOLD) {
        // relative() 而非 replace(cwd+'/')：Windows 下 canonical 是反斜杠路径，
        // 字符串拼 '/' 永远不匹配 → 提示里泄漏完整绝对路径（且教模型复读它）。
        const relPath = relative(params.cwd, canonical!)
        const sizeHint = totalLines > 0
          ? `${totalLines} 行，${entryBytes} bytes`
          : `${entryBytes} bytes`
        // 读盘优先：read_section 直接读磁盘、不依赖历史消息是否完整；
        // 「回看上文」只在 tool_result 未被压缩/修剪时可靠，降为补充。
        const ref = [
          `[read-ref] ${relPath} 本会话已读且未变（${sizeHint}）。`,
          `需要具体区段：read_section(file_path="${relPath}", section="L{N}-L{M}")——直接读磁盘，不依赖上文。`,
          `若上文的 tool_result 仍完整可见，回看即可；若已被压缩为占位符，用 read_section。`,
        ].join('\n')
        if (matchedSame) matchedSame.refServed = (matchedSame.refServed ?? 0) + 1
        if (matchedFull) matchedFull.refServed = (matchedFull.refServed ?? 0) + 1
        // Accumulate into the per-session stats if injected, else the module-level fallback.
        if (params.readRefStats) {
          params.readRefStats.savedBytes += entryBytes
          params.readRefStats.count++
        } else {
          readRefSavedBytes += entryBytes
          readRefCount++
        }
        const totalSaved = params.readRefStats?.savedBytes ?? readRefSavedBytes
        const totalCount = params.readRefStats?.count ?? readRefCount
        debugLog(`[read-ref] file=${canonical} saved=${entryBytes} total-saved=${totalSaved} count=${totalCount}`)
        // 表2 re-registration — 表1/表2 trim independently; without this a
        // 表2-evicted entry can dead-loop the blind-overwrite guard ("read it
        // first" → read-ref short-circuit → 表2 still empty → still refused).
        noteFileObserved(canonical!, currentMtimeMs!, currentSizeBytes!, params.sessionId)
        return { content: ref }
      }
      // Small fragment — fall through to normal read to avoid wasted round-trips
    }

    try {
      // Speculative prewarm hit: if a full-file read (no offset/limit) has a
      // matching prewarm entry (mtime-verified), skip the fs read and apply the
      // current contextWindow's cap to the cached full content. Miss → fall
      // through to the normal fs read below.
      let prefetchedContent: string | undefined
      if (params.prewarmCache && canonical && canUsePrewarmForRead(params.input)) {
        const cached = consumePrewarm(params.prewarmCache, canonical)
        if (cached) {
          prefetchedContent = cached.content
          debugLog(`[prewarm-hit] file=${canonical} cached=${cached.content.length} bytes`)
        }
      }
      payload = await readFilePayload(params.cwd, {
        filePath,
        offset,
        limit,
        modelCap: computedCap,
        prefetchedContent,
      })
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      return { content: `Error: ${message}`, isError: true }
    }

    // P0-2 trace: verify read_file returns full content, not truncated
    debugLog(`[read-cap] file=${payload.canonicalPath} raw=${payload.rawContent.length} model=${payload.modelContent.length} truncated=${payload.rawContent.length !== payload.modelContent.length} cap=${computedCap.maxChars} ctxWindow=${params.contextWindow ?? 'undefined'}`)

    const rawPath = await persistRawOutput(params.toolUseId, payload.rawContent)

    // 表2: note the observed file state so edit-tool staleness checks work.
    if (canonical && currentMtimeMs !== null && currentSizeBytes !== null) {
      noteFileObserved(canonical, currentMtimeMs, currentSizeBytes, params.sessionId)
    }

    // Helper to write the dedup entry once we know whether an artifact was created.
    const recordDedup = (artifactId?: string): void => {
      if (!dedupKey || currentMtimeMs === null || currentSizeBytes === null) return
      readHistory.set(dedupKey, {
        mtimeMs: currentMtimeMs,
        sizeBytes: currentSizeBytes,
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
      if (!canonical || currentMtimeMs === null || currentSizeBytes === null) return
      if (offset !== 1 || limit !== undefined) return // only full reads
      fileReadHistory.set(fileHistoryKey(params.sessionId, canonical), {
        mtimeMs: currentMtimeMs,
        sizeBytes: currentSizeBytes,
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
          content: repeatWarning ? repeatWarning + '\n' + payload.modelContent : payload.modelContent,
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
      const baseContent = payload.modelContent + summaryBlock + `\n[artifact:${artifactId}]`
      return {
        content: repeatWarning ? repeatWarning + '\n' + baseContent : baseContent,
        rawContent: payload.modelContent,
        uiContent: payload.uiContent,
        rawPath,
      }
    }

    // No artifact store — record dedup without an artifactId.
    recordDedup()
    recordFileDedup()
    return {
      content: repeatWarning ? repeatWarning + '\n' + payload.modelContent : payload.modelContent,
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
      const relPath = relative(params.cwd, payload.canonicalPath)
      sections.push(`── ${relPath} ──\n${payload.modelContent}`)
      totalBytes += payload.rawContent.length

      // Record file-level dedup for each file
      const currentStat = await stat(payload.canonicalPath)
      fileReadHistory.set(fileHistoryKey(params.sessionId, payload.canonicalPath), {
        mtimeMs: currentStat.mtimeMs,
        sizeBytes: currentStat.size,
        totalLines: payload.rawContent.split('\n').length,
        rawBytes: payload.rawContent.length,
        modelBytes: payload.modelContent.length,
        recordedAt: Date.now(),
      })
      noteFileObserved(payload.canonicalPath, currentStat.mtimeMs, currentStat.size, params.sessionId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      // trimmed 可能本来就是相对路径——只有以 cwd 开头时才转相对，避免 relative()
      // 把无关路径变成一串 ../..。
      const display = trimmed.startsWith(params.cwd) ? relative(params.cwd, trimmed) : trimmed
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

