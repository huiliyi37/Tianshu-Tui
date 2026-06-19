/**
 * T9 格式化函数 — thinking 指示器。
 *
 * 纯函数，从 `thinking.tsx` 的渲染逻辑提取。
 */

import chalk from 'chalk'
import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatThinkingInput {
  /** thinking 文本内容 */
  text: string
  /** 已用时间（毫秒） */
  elapsedMs: number
  /** 包含头部状态行（凝思中…）。默认 true。流式渲染时 spinner 已显示状态，可设 false。 */
  header?: boolean
  /** 展开正文内容。默认 false。 */
  expanded?: boolean
  /** 正文最大行数。默认 8。commit 时可加大。 */
  maxLines?: number
}

const DEFAULT_MAX_LINES = 8

/**
 * 格式化 thinking 指示器为 ANSI 行数组。
 *
 * header（默认 true）：输出 `◐ 凝思中… (N lines)` 状态行。
 *   流式渲染时 spinner 已显示状态 → 设 false。
 * expanded：输出正文最后 maxLines 行。
 * maxLines（默认 8）：正文截断行数。超限追加 `… +M more lines`。
 */
export function formatThinking(input: FormatThinkingInput, theme: RivetTheme): string[] {
  if (!input.text) return []

  const lines: string[] = []
  const textLines = input.text.split('\n').filter(l => l.trim().length > 0)

  // ── Header line ─────────────────────────────────────────────
  if (input.header !== false) {
    const statusLabel = getThinkingStatus(input.elapsedMs)
    const lineInfo = textLines.length > 0 ? ` (${textLines.length} lines)` : ''
    const useAscii = chalk.level < 3
    const glyph = useAscii ? '~' : '◐'
    lines.push(color(`${glyph} ${statusLabel}${lineInfo}`, theme.dim))
  }

  // ── Content lines ───────────────────────────────────────────
  if (input.expanded && textLines.length > 0) {
    const max = input.maxLines ?? DEFAULT_MAX_LINES
    const visible = textLines.slice(-max)
    for (const line of visible) {
      lines.push(color(`  ${line}`, theme.dim))
    }
    if (textLines.length > max) {
      const hidden = textLines.length - max
      lines.push(color(`  … +${hidden} more lines`, theme.dim))
    }
  }

  return lines
}

function getThinkingStatus(elapsedMs: number): string {
  const s = Math.round(elapsedMs / 1000)
  if (s < 30) return `凝思中… ${s}s`
  if (s < 90) return `汇集上下文… ${s}s`
  if (s < 180) return 'Still thinking…'
  return `长考中 — Ctrl+C 终止 (${Math.floor(s / 60)}m)`
}
