import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'

const MAX_HISTORY = 1000
const HISTORY_PATH = join(homedir(), '.rivet', 'history.json')

export function loadHistory(): string[] {
  try {
    if (!existsSync(HISTORY_PATH)) return []
    return JSON.parse(readFileSync(HISTORY_PATH, 'utf-8'))
  } catch {
    return []
  }
}

export function appendHistory(entry: string): void {
  if (!entry.trim()) return
  const history = loadHistory()
  if (history[0] === entry) return
  history.unshift(entry)
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY
  const dir = join(homedir(), '.rivet')
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  writeFileSync(HISTORY_PATH, JSON.stringify(history, null, 2))
}
