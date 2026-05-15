import { writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

const RAW_DIR = join(tmpdir(), 'rivet-raw')

export interface ToolOutputMeta {
  command: string
  exitCode: number
  durationMs: number
}

export function persistRawOutput(id: string, raw: string): string {
  mkdirSync(RAW_DIR, { recursive: true })
  const filePath = join(RAW_DIR, `${id}.raw`)
  writeFileSync(filePath, raw, 'utf-8')
  return filePath
}

const MODEL_MAX_CHARS = 8000
const MODEL_HEAD_CHARS = 4000
const MODEL_TAIL_CHARS = 3000

function countLines(raw: string): number {
  if (raw.length === 0) return 0
  const parts = raw.split('\n')
  return parts[parts.length - 1] === '' ? parts.length - 1 : parts.length
}

export function buildModelOutput(raw: string, meta: ToolOutputMeta): string {
  const lineCount = countLines(raw)
  const header = `[${meta.command}] exit=${meta.exitCode} time=${(meta.durationMs / 1000).toFixed(1)}s lines=${lineCount}`

  if (raw.length <= MODEL_MAX_CHARS) {
    return `${header}\n${raw}`
  }

  const head = raw.slice(0, MODEL_HEAD_CHARS)
  const tail = raw.slice(-MODEL_TAIL_CHARS)
  const omitted = raw.length - MODEL_HEAD_CHARS - MODEL_TAIL_CHARS
  return `${header}\n${head}\n... (${omitted} bytes omitted) ...\n${tail}`
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
