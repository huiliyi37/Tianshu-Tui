/**
 * T9 格式化函数 — 常驻任务面板（todo task list）。
 *
 * Claude Code 风格三态 checklist，渲染为 ANSI 行数组：
 *   ☐ pending     — muted
 *   ◐ in_progress — primary 高亮 + bold（当前焦点）
 *   ☒ completed   — dim（已完成）
 *
 * 纯函数：空列表返回 `[]`（不渲染），限高（默认 ≤6 行 + “+N more”）。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { TodoItem } from '../../tools/todo-store.js'

export interface TaskListOptions {
  /** 终端宽度（内容超宽截断） */
  width?: number
  /** 面板最大行数（含 “+N more”），默认 6 */
  maxRows?: number
}

/** 三态字形（与 Claude Code 对齐）。 */
function glyphFor(status: TodoItem['status']): string {
  switch (status) {
    case 'completed': return '☒'
    case 'in_progress': return '◐'
    default: return '☐'
  }
}

/**
 * 将 todo 列表格式化为常驻面板行。空列表返回 `[]`。
 *
 * 排序展示策略对齐 Claude：保持模型给定顺序（id 即顺序），不重排，
 * 让 in_progress 高亮、completed 暗化，read-at-a-glance。
 */
export function formatTaskList(items: TodoItem[], theme: RivetTheme, opts: TaskListOptions = {}): string[] {
  if (items.length === 0) return []
  const width = opts.width ?? 80
  const maxRows = Math.max(2, opts.maxRows ?? 6)

  const lines: string[] = []
  const done = items.filter(t => t.status === 'completed').length
  // 标题：◇ Tasks (done/total)
  lines.push(color(`◇ 任务 ${done}/${items.length}`, theme.secondary, { bold: true }))

  // 预留 1 行给 “+N more”（仅当确有溢出时）
  const overflow = items.length > maxRows - 1
  const visibleCount = overflow ? maxRows - 2 : items.length
  const maxContentWidth = Math.max(8, width - 4)

  for (let i = 0; i < visibleCount; i++) {
    const t = items[i]!
    const glyph = glyphFor(t.status)
    let content = t.content
    if (content.length > maxContentWidth) {
      content = `${content.slice(0, maxContentWidth - 1)}…`
    }
    let line: string
    if (t.status === 'in_progress') {
      line = `${color(glyph, theme.primary, { bold: true })} ${color(content, theme.primary, { bold: true })}`
    } else if (t.status === 'completed') {
      line = `${color(glyph, theme.dim)} ${color(content, theme.dim)}`
    } else {
      line = `${color(glyph, theme.muted)} ${color(content, theme.muted)}`
    }
    lines.push(line)
  }

  if (overflow) {
    const remaining = items.length - visibleCount
    lines.push(color(`  +${remaining} more`, theme.dim))
  }

  return lines
}
