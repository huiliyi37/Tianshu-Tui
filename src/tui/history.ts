import { readFileSync, existsSync } from 'fs'
import { writeFileAtomicSync } from '../fs-atomic.js'
import { join } from 'path'
import { homedir } from 'os'

export const MAX_HISTORY = 1000
const HISTORY_PATH = join(homedir(), '.rivet', 'history.json')

export function loadHistory(): string[] {
  try {
    if (!existsSync(HISTORY_PATH)) return []
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'))
  } catch {
    return []
  }
}

export function nextHistoryAfterSubmit(history: string[], entry: string): string[] {
  const trimmed = entry.trim()
  if (!trimmed) return history
  if (history[0] === trimmed) return history
  return [trimmed, ...history].slice(0, MAX_HISTORY)
}

export function appendHistory(entry: string): void {
  const history = nextHistoryAfterSubmit(loadHistory(), entry)
  writeFileAtomicSync(HISTORY_PATH, JSON.stringify(history, null, 2))
}
