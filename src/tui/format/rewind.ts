/**
 * T9 Rewind overlay — ANSI 渲染器。
 *
 * 对标 Ink rewind-list.tsx：显示最近 N 条用户消息，选择后可撤销。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface RewindEntry {
  index: number
  content: string
  ts?: number
}

export interface RewindData {
  entries: RewindEntry[]
  selectedIndex: number
}

export function renderRewind(data: RewindData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const w = width - 4

  lines.push('')
  lines.push(`  ${color('⏪ Rewind', theme.primary, { bold: true })}  ${color('— 选择消息以撤销', theme.dim)}`)
  lines.push('')

  if (data.entries.length === 0) {
    lines.push(`  ${color('No messages to rewind.', theme.dim)}`)
    return lines
  }

  const maxVisible = height - 6
  for (let i = 0; i < Math.min(data.entries.length, maxVisible); i++) {
    const entry = data.entries[i]!
    const isSelected = i === data.selectedIndex
    const prefix = isSelected ? color('▶', theme.primary, { bold: true }) : ' '
    const idx = color(`#${entry.index}`.padEnd(5), theme.muted)
    const preview = entry.content.length > w - 10
      ? entry.content.slice(0, w - 13) + '…'
      : entry.content
    const text = isSelected
      ? color(preview.replace(/\n/g, ' '), theme.primary, { bold: true })
      : color(preview.replace(/\n/g, ' '), theme.secondary)

    lines.push(`  ${prefix} ${idx}${text}`)
  }

  // Pad
  const usedLines = lines.length
  for (let i = usedLines; i < height - 2; i++) {
    lines.push('')
  }

  lines.push(`  ${color('↑↓ select  Enter confirm  q cancel', theme.dim)}`)
  return lines
}
