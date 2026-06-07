import { readFileSync, existsSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'

export interface FileSnapshot {
  path: string
  content: string
}

export interface HistoryEntry {
  messageId: string
  files: FileSnapshot[]
  timestamp: number
}

/** Maximum JSON payload size for file history persistence (1MB).
 *  Beyond this, the history is too large to persist synchronously
 *  without blocking the event loop during shutdown. */
const MAX_PAYLOAD_BYTES = 1024 * 1024

export function persistFileHistory<T = HistoryEntry>(filePath: string, entries: T[], maxSnapshots = 50): void {
  const trimmed = entries.length > maxSnapshots ? entries.slice(-maxSnapshots) : entries
  const json = JSON.stringify(trimmed)
  // Guard against enormous payloads that would block shutdown for seconds
  if (json.length > MAX_PAYLOAD_BYTES) {
    // Keep only the most recent 20% of snapshots as a fallback
    const fallback = trimmed.slice(-Math.max(10, Math.floor(trimmed.length * 0.2)))
    const fallbackJson = JSON.stringify(fallback)
    if (fallbackJson.length <= MAX_PAYLOAD_BYTES) {
      writeFileAtomicSync(filePath, fallbackJson)
    }
    return
  }
  writeFileAtomicSync(filePath, json)
}

export function loadFileHistory<T = HistoryEntry>(filePath: string): T[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T[]
  } catch {
    return []
  }
}
