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
  /** 是否正在流式输出 */
  isStreaming: boolean
  /** 是否已展开 */
  expanded?: boolean
}

const MAX_VISIBLE_LINES = 8

/**
 * 格式化 thinking 指示器为 ANSI 行数组。
 *
 * 折叠状态：一行（状态标签 + thinking 行数）
 * 展开状态：最后 8 行 thinking 内容
 * 静止状态（!isStreaming）：空
 */
export function formatThinking(input: FormatThinkingInput, theme: RivetTheme): string[] {
  if (!input.isStreaming) return []

  const lines: string[] = []
  const statusLabel = getThinkingStatus(input.elapsedMs)

  // ── Status line ─────────────────────────────────────────────
  const textLines = input.text.split('\n').filter(l => l.trim().length > 0)
  const lineInfo = textLines.length > 0 ? ` (${textLines.length} lines)` : ''
  const useAscii = chalk.level < 3
  const glyph = useAscii ? '~' : '◐'
  lines.push(color(`${glyph} ${statusLabel}${lineInfo}`, theme.dim))

  // ── Expanded content ────────────────────────────────────────
  if (input.expanded && textLines.length > 0) {
    const visible = textLines.slice(-MAX_VISIBLE_LINES)
    for (const line of visible) {
      lines.push(color(`  ${line}`, theme.dim))
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
