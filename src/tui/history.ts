import { readFileSync, existsSync } from 'fs'
import { readFile } from 'fs/promises'
import { writeFileAtomicSync, writeFileAtomicAsync } from '../fs-atomic.js'
import { join } from 'path'
import { historyPath } from '../config/paths.js'

export const MAX_HISTORY = 1000
const HISTORY_PATH = historyPath()
let historyAppendQueue: Promise<void> = Promise.resolve()

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
  const pending = historyAppendQueue.then(async () => {
    const history = nextHistoryAfterSubmit(await loadHistoryAsync(), entry)
    await writeFileAtomicAsync(HISTORY_PATH, JSON.stringify(history, null, 2))
  })
  // Keep later appends runnable after a rejected write while preserving the
  // rejection for this caller.
  historyAppendQueue = pending.catch(() => {})
  return pending
}

/** 模糊搜索历史记录，返回匹配项及得分 */
export function searchHistory(query: string, limit = 20): string[] {
  return scoreHistoryEntries(loadHistory(), query, limit)
}

/** 纯函数：对给定历史条目按 query 评分排序（前缀 +10、词命中 +5）。
 *  从 searchHistory 抽出便于单测（磁盘 loadHistory 不进测试）。 */
export function scoreHistoryEntries(entries: readonly string[], query: string, limit = 20): string[] {
  if (!query) return entries.slice(0, limit)
  const lower = query.toLowerCase()
  return entries
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
    .map(s => s.entry)
}
