/**
 * T9 格式化函数 — 常驻任务面板（todo task list）。
 *
 * Claude Code 风格三态 checklist，渲染为 ANSI 行数组：
 *   ☐ pending     — muted
 *   ◐ in_progress — primary 高亮 + bold（当前焦点）
 *   ☒ completed   — dim（已完成）
 *
 * 纯函数：空列表返回 `[]`（不渲染），限高（默认 ≤6 行 + "+N more"）。
 *
 * 智能可见窗口：当条目数超过 maxRows 时，优先显示 in_progress 和 pending，
 * 折叠 completed 到摘要行，确保活跃任务永不被 "+N more" 吞掉。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { TodoItem } from '../../tools/todo-store.js'

export interface TaskListOptions {
  /** 终端宽度（内容超宽截断） */
  width?: number
  /** 面板最大行数（含标题 + 摘要行），默认 6 */
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

function renderLine(t: TodoItem, theme: RivetTheme, maxContentWidth: number): string {
  const glyph = glyphFor(t.status)
  let content = t.content
  if (content.length > maxContentWidth) {
    content = `${content.slice(0, maxContentWidth - 1)}…`
  }
  if (t.status === 'in_progress') {
    return `${color(glyph, theme.primary, { bold: true })} ${color(content, theme.primary, { bold: true })}`
  } else if (t.status === 'completed') {
    return `${color(glyph, theme.dim)} ${color(content, theme.dim)}`
  } else {
    return `${color(glyph, theme.muted)} ${color(content, theme.muted)}`
  }
}

/**
 * 将 todo 列表格式化为常驻面板行。空列表返回 `[]`。
 *
 * 可见窗口策略（解决"后面的默认沉底"问题）：
 * 1. in_progress 永远可见
 * 2. pending 按 id 顺序填充剩余行
 * 3. completed 折叠为摘要（"✓ 3 done"），不逐条占用行
 * 4. 仅当 in_progress + pending 仍超行时才显示 "+N more"
 */
export function formatTaskList(items: TodoItem[], theme: RivetTheme, opts: TaskListOptions = {}): string[] {
  if (items.length === 0) return []
  const width = opts.width ?? 80
  const maxRows = Math.max(3, opts.maxRows ?? 6)
  const maxContentWidth = Math.max(8, width - 4)

  const lines: string[] = []
  const completed = items.filter(t => t.status === 'completed')
  const active = items.filter(t => t.status === 'in_progress')
  const pending = items.filter(t => t.status === 'pending')
  const done = completed.length

  // 标题：◇ 任务 (done/total)
  lines.push(color(`◇ 任务 ${done}/${items.length}`, theme.secondary, { bold: true }))

  // 预算：标题已占 1 行，完成摘要占 1 行（当有完成项时）
  let budget = maxRows - 1 // 去掉标题
  if (done > 0) budget -= 1 // 完成摘要行

  // 优先级：in_progress → pending（保持原 id 顺序合并）
  const unfinished = items.filter(t => t.status !== 'completed')

  let visibleCount: number
  let hasOverflow = false

  if (unfinished.length <= budget) {
    // 全部未完成项都能显示
    visibleCount = unfinished.length
  } else {
    // 超预算：in_progress 全显示，pending 填充剩余，溢出走 +N more
    visibleCount = budget - 1 // 留 1 行给 +N more
    hasOverflow = true
  }

  // 渲染可见的未完成项
  for (let i = 0; i < Math.min(visibleCount, unfinished.length); i++) {
    lines.push(renderLine(unfinished[i]!, theme, maxContentWidth))
  }

  if (hasOverflow) {
    const remaining = unfinished.length - visibleCount
    lines.push(color(`  +${remaining} more`, theme.dim))
  }

  // 完成项折叠摘要（不逐条显示，节省行数给活跃任务）
  if (done > 0) {
    const sample = completed[0]!.content
    const sampleText = sample.length > maxContentWidth - 8
      ? `${sample.slice(0, maxContentWidth - 9)}…`
      : sample
    if (done === 1) {
      lines.push(color(`  ✓ ${sampleText}`, theme.dim))
    } else {
      lines.push(color(`  ✓ ${done} done`, theme.dim))
    }
  }

  return lines
}
