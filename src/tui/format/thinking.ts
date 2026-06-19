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
  /** 推理已完成（提交到 scrollback）。头部用过去式「✶ 已推理」而非进行时「◐ 凝思中…」。默认 false。 */
  done?: boolean
}

const DEFAULT_MAX_LINES = 8

/**
 * 格式化 thinking 指示器为 ANSI 行数组。
 *
 * header（默认 true）：输出状态行。
 *   done=false → `◐ 凝思中… (N lines)`（进行时，流式期 spinner 已显示状态可设 header:false）。
 *   done=true  → `✶ 已推理 · Ns · N 行`（过去式，commit 到 scrollback 用）。
 * expanded：输出正文最后 maxLines 行。
 * maxLines（默认 8）：正文截断行数。隐藏的是开头若干行（保留最新 tail），
 *   故超限提示「… 上方省略 M 行」放在正文上方，避免「底部提示暗示后面还有」的误导。
 */
export function formatThinking(input: FormatThinkingInput, theme: RivetTheme): string[] {
  if (!input.text) return []

  const lines: string[] = []
  const textLines = input.text.split('\n').filter(l => l.trim().length > 0)
  const useAscii = chalk.level < 3

  // ── Header line ─────────────────────────────────────────────
  if (input.header !== false) {
    if (input.done) {
      const secs = Math.round(input.elapsedMs / 1000)
      const glyph = useAscii ? '*' : '✶'
      const lineInfo = textLines.length > 0 ? ` · ${textLines.length} 行` : ''
      lines.push(color(`${glyph} 已推理 · ${secs}s${lineInfo}`, theme.dim))
    } else {
      const statusLabel = getThinkingStatus(input.elapsedMs)
      const lineInfo = textLines.length > 0 ? ` (${textLines.length} lines)` : ''
      const glyph = useAscii ? '~' : '◐'
      lines.push(color(`${glyph} ${statusLabel}${lineInfo}`, theme.dim))
    }
  }

  // ── Content lines (保留最新 maxLines 行的 tail) ──────────────
  if (input.expanded && textLines.length > 0) {
    const max = input.maxLines ?? DEFAULT_MAX_LINES
    if (textLines.length > max) {
      lines.push(color(`  … 上方省略 ${textLines.length - max} 行`, theme.dim))
    }
    for (const line of textLines.slice(-max)) {
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
