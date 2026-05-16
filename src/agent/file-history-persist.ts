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

export function persistFileHistory<T = HistoryEntry>(filePath: string, entries: T[], maxSnapshots = 50): void {
  const trimmed = entries.length > maxSnapshots ? entries.slice(-maxSnapshots) : entries
  writeFileAtomicSync(filePath, JSON.stringify(trimmed))
}

export function loadFileHistory<T = HistoryEntry>(filePath: string): T[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T[]
  } catch {
    return []
  }
}
