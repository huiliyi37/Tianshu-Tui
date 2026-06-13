import { readFileSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'
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

async function loadHistoryAsync(): Promise<string[]> {
  try {
    return JSON.parse(await readFile(HISTORY_PATH, 'utf-8'))
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

/** 异步持久化历史记录，不阻塞调用方。供 key handler 等延迟敏感路径使用。 */
export async function appendHistoryAsync(entry: string): Promise<void> {
  const history = nextHistoryAfterSubmit(await loadHistoryAsync(), entry)
  await writeFileAtomicAsync(HISTORY_PATH, JSON.stringify(history, null, 2))
}

/** 模糊搜索历史记录，返回匹配项及得分 */
export function searchHistory(query: string, limit = 20): string[] {
  if (!query) return loadHistory().slice(0, limit)
  const lower = query.toLowerCase()
  const history = loadHistory()
  const scored = history
    .filter(e => e.toLowerCase().includes(lower))
    .map(e => {
      let score = 0
      if (e.toLowerCase().startsWith(lower)) score += 10
      // 单词边界匹配加分
      for (const word of lower.split(/\s+/)) {
        if (e.toLowerCase().includes(word)) score += 5
      }
      return { entry: e, score }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
  return scored.map(s => s.entry)
}
