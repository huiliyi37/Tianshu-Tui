// Command palette model (Q4). `filterCommands` is a pure fuzzy filter so it can
// be unit-tested without React.

/** 「更多」等入口 → 命令面板。palette 开关是 App.tsx 本地 state，经 window
 *  事件桥接，避免为一个布尔值把 state 提升进全局 store。 */
export const OPEN_PALETTE_EVENT = 'tianshu:open-palette'

export interface Command {
  id: string
  label: string
  hint?: string
  run: () => void
  subMode?: 'switch-model' | 'open-file'
}

/** Substring (preferred, earlier = higher) → subsequence fallback → -1 miss. */
export function fuzzyScore(text: string, query: string): number {
  if (!query) return 0
  const idx = text.indexOf(query)
  if (idx >= 0) return 1000 - idx
  let ti = 0
  let matched = 0
  for (const ch of query) {
    const found = text.indexOf(ch, ti)
    if (found < 0) return -1
    ti = found + 1
    matched += 1
  }
  return matched
}

export function filterCommands(items: Command[], query: string): Command[] {
  const q = query.trim().toLowerCase()
  if (!q) return items
  return items
    .map((c) => ({ c, score: fuzzyScore(`${c.label} ${c.hint ?? ''}`.toLowerCase(), q) }))
    .filter((x) => x.score >= 0)
    .sort((a, b) => b.score - a.score)
    .map((x) => x.c)
}
