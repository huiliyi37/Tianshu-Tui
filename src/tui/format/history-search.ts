/**
 * T9 History Search overlay — Ctrl+R 反向历史搜索。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface HistorySearchEntry {
  text: string
}

export interface HistorySearchData {
  entries: string[]
  selectedIndex: number
  query: string
}

export function renderHistorySearch(data: HistorySearchData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const w = width - 4

  lines.push('')
  lines.push(`  ${color('⌛ History Search', theme.primary, { bold: true })}  ${color('— Ctrl+R', theme.dim)}`)
  lines.push(`  ${color('> ', theme.primary)}${data.query || color('type to search…', theme.dim)}`)
  lines.push('')

  if (data.entries.length === 0) {
    if (data.query) {
      lines.push(`  ${color('No matches found.', theme.dim)}`)
    }
  } else {
    const maxVisible = height - 7
    for (let i = 0; i < Math.min(data.entries.length, maxVisible); i++) {
      const entry = data.entries[i]!
      const isSelected = i === data.selectedIndex
      const prefix = isSelected ? color('▶', theme.primary, { bold: true }) : ' '
      const preview = entry.length > w - 4
        ? entry.slice(0, w - 7) + '…'
        : entry
      const text = isSelected
        ? color(preview, theme.primary)
        : color(preview, theme.muted)

      lines.push(`  ${prefix} ${text}`)
    }
  }

  // Pad
  const usedLines = lines.length
  for (let i = usedLines; i < height - 2; i++) {
    lines.push('')
  }

  lines.push(`  ${color('↑↓ select  Enter paste  Esc cancel', theme.dim)}`)
  return lines
}
