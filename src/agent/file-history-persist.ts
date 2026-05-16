import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { dirname } from 'path'

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
  const dir = dirname(filePath)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const trimmed = entries.length > maxSnapshots ? entries.slice(-maxSnapshots) : entries
  writeFileSync(filePath, JSON.stringify(trimmed))
}

export function loadFileHistory<T = HistoryEntry>(filePath: string): T[] {
  if (!existsSync(filePath)) return []
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as T[]
  } catch {
    return []
  }
}
