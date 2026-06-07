export type LogEntryType =
  | 'user_message'
  | 'assistant_message'
  | 'thinking_message'
  | 'tool'
  | 'tool_group'
  | 'checkpoint'
  | 'evidence'
  | 'system'
  | 'turn_summary'

export interface LogEntry {
  type: LogEntryType
  id: string
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
  /** Nesting depth for tool call chain indentation (0 = root). */
  depth?: number
  thinking?: string
}

let _nextLogId = 0

export const MAX_LOG_STORE = 5000

export function createLogEntry(entry: {
  id?: string
  type: LogEntryType
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
  turnNumber?: number
  children?: LogEntry[]
  /** Nesting depth for tool call chain indentation (0 = root). */
  depth?: number
  thinking?: string
}): LogEntry {
  return { ...entry, id: entry.id ?? `l${_nextLogId++}` }
}

export function appendLog(logs: readonly LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...logs, entry]
  if (next.length <= MAX_LOG_STORE) return next
  return next.slice(next.length - MAX_LOG_STORE + 50)
}

export function appendLogInPlace(logs: LogEntry[], entry: LogEntry): void {
  const next = appendLog(logs, entry)
  logs.length = 0
  logs.push(...next)
}

export function visibleLogs(logs: LogEntry[], maxVisible: number): LogEntry[] {
  return logs.slice(-maxVisible)
}

export function updateToolLog(
  logs: LogEntry[],
  id: string,
  toolName: string,
  content: string,
  isError?: boolean,
  rawPath?: string,
): LogEntry[] {
  let idx = -1
  for (let i = logs.length - 1; i >= 0; i--) {
    const entry = logs[i]
    if (entry?.type === 'tool' && entry?.id === id) {
      idx = i
      break
    }
  }
  if (idx === -1) {
    return [...logs, { type: 'tool' as const, id, toolName, content, isError, rawPath }]
  }

  const existing = logs[idx]!
  if (existing.content === content && existing.isError === isError && existing.rawPath === rawPath) {
    return logs
  }

  return logs.map((entry, index) => {
    if (index !== idx) return entry
    return { type: 'tool' as const, id, toolName: entry.toolName ?? toolName, content, isError: isError ?? entry.isError, rawPath: rawPath ?? entry.rawPath }
  })
}

export function summarizeToolOutput(output: string, maxLines: number): string {
  const lines = output.split('\n')
  if (lines.length <= maxLines) return output

  const headCount = Math.ceil(maxLines / 2)
  const tailCount = Math.floor(maxLines / 2)
  const head = lines.slice(0, headCount)
  const tail = lines.slice(-tailCount)
  const omitted = lines.length - head.length - tail.length
  return [...head, `... ${omitted} lines omitted ...`, ...tail].join('\n')
}
