export interface LogEntry {
  type: 'text' | 'tool' | 'checkpoint' | 'evidence'
  id?: string
  content: string
  toolName?: string
  isError?: boolean
  rawPath?: string
}

export function appendLog(logs: LogEntry[], entry: LogEntry): LogEntry[] {
  return [...logs, entry]
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
    return [...logs, { type: 'tool', id, toolName, content, isError, rawPath }]
  }

  const existing = logs[idx]!
  // Skip update if content unchanged — prevents unnecessary React reconciliation
  if (existing.content === content && existing.isError === isError && existing.rawPath === rawPath) {
    return logs
  }

  return logs.map((entry, index) => {
    if (index !== idx) return entry
    return { type: 'tool', id, toolName: entry.toolName ?? toolName, content, isError: isError ?? entry.isError, rawPath: rawPath ?? entry.rawPath }
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
