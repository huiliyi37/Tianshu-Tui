import { writeFile, mkdir, readdir, unlink, stat } from 'node:fs/promises'
import { createHash, randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const RAW_DIR = join(tmpdir(), 'rivet-raw')
const STALE_TTL_MS = 3_600_000 // 1 hour
const CLEAN_INTERVAL = 10 // clean every N calls

let persistCount = 0

export interface ToolOutputMeta {
  command: string
  exitCode: number
  durationMs: number
}

function safeRawFileName(id: string): string {
  const hash = createHash('sha256').update(id || randomUUID()).digest('hex').slice(0, 24)
  return `${hash}.raw`
}

export async function persistRawOutput(id: string, raw: string): Promise<string> {
  await mkdir(RAW_DIR, { recursive: true })
  const filePath = join(RAW_DIR, safeRawFileName(id))
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
    names = await readdir(RAW_DIR)
  } catch {
    return
  }
  const cutoff = Date.now() - STALE_TTL_MS
  for (const name of names) {
    const filePath = join(RAW_DIR, name)
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

function countLines(raw: string): number {
  if (raw.length === 0) return 0
  const parts = raw.split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

export function buildModelOutput(raw: string, meta: ToolOutputMeta): string {
  const lines = raw.split('\n')
  const lineCount = countLines(raw)
  const header = `[${meta.command}] exit=${meta.exitCode} time=${(meta.durationMs / 1000).toFixed(1)}s lines=${lineCount}`

  if (lines.length <= MODEL_MAX_LINES) {
    return `${header}\n${raw}`
  }

  const head = lines.slice(0, MODEL_HEAD_LINES)
  const tail = lines.slice(-MODEL_TAIL_LINES)
  const omitted = lines.length - MODEL_HEAD_LINES - MODEL_TAIL_LINES
  return `${header}\n${head.join('\n')}\n... (${omitted} lines omitted) ...\n${tail.join('\n')}`
}

export function buildUiOutput(raw: string, meta: ToolOutputMeta, maxLines = 20): string {
  const lines = raw.split('\n')
  const status = meta.exitCode === 0 ? '✓' : '✗'
  const header = `${status} ${meta.command} (${(meta.durationMs / 1000).toFixed(1)}s)`

  if (lines.length <= maxLines) {
    return raw.length > 0 ? `${header}\n${raw}` : header
  }

  const tail = lines.slice(-maxLines)
  const omitted = lines.length - maxLines
  return `${header}\n... ${omitted} lines omitted ...\n${tail.join('\n')}`
}
