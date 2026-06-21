import { writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { applyCommandFilter } from './command-filters.js'

// Lazily compute RAW_DIR so tests (or agents inside a Seatbelt boundary) can
// redirect TMPDIR at runtime. Module-level `const RAW_DIR = join(tmpdir(), ...)`
// captures the path at import time — before any before() hook runs.
function rawDir(): string {
  return join(tmpdir(), 'rivet-raw')
}
const STALE_TTL_MS = 3_600_000 // 1 hour
const CLEAN_INTERVAL = 10 // clean every N calls

let persistCount = 0

export interface ToolOutputMeta {
  command: string
  exitCode: number
  durationMs: number
  /** Path to the persisted full raw output. When present, truncation footers
   *  include a recovery hint so the model reads the file instead of re-running
   *  the command with sed/head/tee variants (doom-loop root cause, 会话 43443098). */
  rawPath?: string
}

function safeRawFileName(id: string): string {
  const hash = createHash('sha256').update(id || randomUUID()).digest('hex').slice(0, 24)
  return `${hash}.raw`
}

export async function persistRawOutput(id: string, raw: string): Promise<string> {
  await mkdir(rawDir(), { recursive: true })
  const filePath = join(rawDir(), safeRawFileName(id))
  await writeFile(filePath, raw, 'utf-8')

  persistCount++
  if (persistCount % CLEAN_INTERVAL === 0) {
    cleanStaleRawOutputs().catch(() => {})
  }

  return filePath
}

async function cleanStaleRawOutputs(): Promise<void> {
  let names: string[]
  try {
    names = await readdir(rawDir())
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_TTL_MS
  for (const name of names) {
    const filePath = join(rawDir(), name)
    try {
      const s = await stat(filePath)
      if (s.mtimeMs < cutoff) {
        await unlink(filePath)
      }
    } catch {
      // skip
    }
  }
}

const MODEL_MAX_LINES = 200
const MODEL_HEAD_LINES = 100
const MODEL_TAIL_LINES = 80
const SUCCESS_INLINE_LINES = 20
const SUCCESS_TAIL_LINES = 20

function countLines(raw: string): number {
  if (raw.length === 0) return 0
  const parts = raw.split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

export function buildModelOutput(raw: string, meta: ToolOutputMeta): string {
  // Apply command-aware filter first (P1: Command-Aware filtering)
  // Only apply filter when exitCode !== 0 (failure) to avoid hiding useful info
  const filtered = meta.exitCode !== 0 ? applyCommandFilter(meta.command, raw, meta.exitCode) : null
  const effectiveRaw = filtered ?? raw
  const lines = effectiveRaw.split('\n')
  const lineCount = countLines(effectiveRaw)
  const header = `[${meta.command}] exit=${meta.exitCode} time=${(meta.durationMs / 1000).toFixed(1)}s lines=${lineCount}`

  // Recovery hint: without it the model retries the same command with
  // sed/head/python/tee variants to "see the rest" — the doom-loop trigger.
  const recovery = meta.rawPath ? ` · full output: read_file ${meta.rawPath} — 不要重跑命令` : ''

  // Empty output: explicitly confirm it's genuinely empty (not collapsed)
  if (lineCount === 0 && effectiveRaw.length === 0) {
    return `${header}\n[output complete: 0 lines — confirmed empty]`
  }

  // Success output that's folded (too many lines for inline display)
  if (meta.exitCode === 0 && lineCount > SUCCESS_INLINE_LINES) {
    const tail = lines.slice(-SUCCESS_TAIL_LINES)
    const omitted = lineCount - SUCCESS_TAIL_LINES
    return `${header}\n... ${omitted} lines omitted ...\n${tail.join('\n')}\n[output truncated: last ${SUCCESS_TAIL_LINES} of ${lineCount} lines shown — ${omitted} lines omitted${recovery}]`
  }

  // Output fits within model max lines — complete
  if (lines.length <= MODEL_MAX_LINES) {
    return `${header} — output complete\n${effectiveRaw}`
  }

  // Output exceeds model max lines — head + tail truncation
  const head = lines.slice(0, MODEL_HEAD_LINES)
  const tail = lines.slice(-MODEL_TAIL_LINES)
  const omitted = lines.length - MODEL_HEAD_LINES - MODEL_TAIL_LINES
  const kept = MODEL_HEAD_LINES + MODEL_TAIL_LINES
  return `${header}\n${head.join('\n')}\n... (${omitted} lines omitted) ...\n${tail.join('\n')}\n[output truncated: head ${MODEL_HEAD_LINES} + tail ${MODEL_TAIL_LINES} of ${lines.length} lines shown — ${omitted} lines omitted${recovery}]`
}

export function buildUiOutput(raw: string, meta: ToolOutputMeta, maxLines = 20): string {
  const lines = raw.split('\n')
  const status = meta.exitCode === 0 ? '✓' : '✗'
  const header = `${status} ${meta.command} (${(meta.durationMs / 1000).toFixed(1)}s)`

  if (lines.length <= maxLines) {
    return raw.length > 0 ? `${header}\n${raw}` : header
  }

  // Error-aware truncation: for failed commands, prioritize error/warning lines
  // so the model sees the failure reason without needing to read the rawPath
  if (meta.exitCode !== 0) {
    const errorLines = extractErrorAwareLines(lines, maxLines)
    const omitted = lines.length - errorLines.length
    return `${header}\n... ${omitted} non-error lines skipped ...\n${errorLines.join('\n')}\n[truncated: ${lines.length} lines → ${errorLines.length} error-aware shown]`
  }

  // Success output: standard tail truncation
  const tail = lines.slice(-maxLines)
  const omitted = lines.length - maxLines
  return `${header}\n... ${omitted} lines omitted ...\n${tail.join('\n')}\n[truncated: ${lines.length} lines → ${maxLines} shown]`
}

/**
 * Error-aware line extraction: scans for error markers and keeps surrounding context.
 * Falls back to head+tail split if no error markers found or selection exceeds maxLines.
 */
function extractErrorAwareLines(lines: string[], maxLines: number): string[] {
  // Patterns that indicate a line is diagnostically significant
  const markerRegex = /error\b|Error:|FAIL\b|AssertionError|assert|✗|✘|×|at\s+\S+\.(ts|tsx|js|jsx):\d+|^\s+\d+\s+\|\s|^\s+>/i

  // Find all error-line indices
  const errorIdxs: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (markerRegex.test(lines[i]!)) {
      errorIdxs.push(i)
    }
  }

  // If no error markers found, fall back to head + tail
  if (errorIdxs.length === 0) {
    const head = Math.ceil(maxLines / 3)
    const tail = maxLines - head
    return [
      ...lines.slice(0, head),
      `... (${lines.length - maxLines} lines skipped, no error markers detected) ...`,
      ...lines.slice(-tail),
    ]
  }

  // Collect error lines with context (±2 lines), deduplicate overlapping ranges
  const contextRadius = 2
  const included = new Set<number>()

  // Always include first 3 lines for context (command header, etc.)
  for (let i = 0; i < Math.min(3, lines.length); i++) included.add(i)
  // Always include last 2 lines (summary, exit info)
  for (let i = Math.max(0, lines.length - 2); i < lines.length; i++) included.add(i)

  // Process error markers from last to first (prioritize later errors in tight scenarios)
  const sorted = [...errorIdxs].sort((a, b) => b - a)
  for (const idx of sorted) {
    const start = Math.max(0, idx - contextRadius)
    const end = Math.min(lines.length, idx + contextRadius + 1)
    for (let i = start; i < end; i++) included.add(i)
  }

  // Build result with ... markers for gaps
  const result: string[] = []
  let prev = -2
  for (const idx of [...included].sort((a, b) => a - b)) {
    if (idx > prev + 1) {
      result.push('...')
    }
    result.push(lines[idx]!)
    prev = idx
  }

  // If result fits, return it; otherwise fall back to head+tail
  if (result.length <= maxLines + 5) {
    return result
  }

  // Fallback: head + tail, but ensure we include the last error
  const lastErrorIdx = errorIdxs[errorIdxs.length - 1]!
  const headSize = Math.min(Math.ceil(maxLines / 2), lastErrorIdx - 3)
  const tailStart = Math.max(headSize, lastErrorIdx - Math.floor(maxLines / 2))
  
  const head = lines.slice(0, headSize)
  const tail = lines.slice(tailStart, tailStart + maxLines - headSize)
  return [
    ...head,
    `... (${tailStart - headSize} lines skipped) ...`,
    ...tail,
  ]
}
