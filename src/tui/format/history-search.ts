/**
 * T9 History Search overlay — Ctrl+R 反向历史搜索。
 *
 * 采用统一面板骨架（overlay-frame）：加框 + 居中标题 + 中文页脚。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import {
  frameTop,
  frameBottom,
  frameTitle,
  frameFooter,
  frameLine,
  CURSOR,
  keyHints,
} from './overlay-frame.js'

export interface HistorySearchEntry {
  text: string
}

export interface HistorySearchData {
  entries: string[]
  selectedIndex: number
  query: string
}

export function renderHistorySearch(data: HistorySearchData, width: number, height: number, theme: RivetTheme): string[] {
  const w = Math.max(20, width - 4)
  const contentRows = Math.max(3, height - 4) // top + title + footer + bottom

  const lines: string[] = [
    frameTop(width, theme),
    frameTitle('⌛ 历史搜索 · Ctrl+R', width, theme),
  ]

  const body: string[] = []
  body.push(` ${color('> ', theme.primary)}${data.query || color('输入以搜索…', theme.dim)}`)
  body.push('')

  if (data.entries.length === 0) {
    if (data.query) body.push(`  ${color('无匹配结果。', theme.muted)}`)
  } else {
    const maxVisible = Math.max(1, contentRows - body.length)
    const selected = Math.max(0, Math.min(data.selectedIndex, data.entries.length - 1))
    for (let i = 0; i < Math.min(data.entries.length, maxVisible); i++) {
      const entry = data.entries[i]!
      const isSelected = i === selected
      const prefix = isSelected ? color(CURSOR, theme.primary, { bold: true }) : ' '
      const preview = entry.length > w - 4 ? entry.slice(0, w - 7) + '…' : entry
      const text = isSelected ? color(preview, theme.primary, { bold: true }) : color(preview, theme.muted)
      body.push(` ${prefix} ${text}`)
    }
  }

  for (let i = 0; i < contentRows; i++) lines.push(frameLine(body[i] ?? '', width, theme))
  lines.push(frameFooter(keyHints([['↑↓', '选择'], ['Enter', '粘贴'], ['Esc', '取消']]), width, theme))
  lines.push(frameBottom(width, theme))
  return lines
}
