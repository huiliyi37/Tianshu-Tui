/**
 * [未接线 / NOT WIRED] T9 格式化函数 — assistant 消息（· 前缀水墨风格）。
 * 主路径（engine/app.ts）使用 StreamRenderer + formatMarkdown，不走此模块（仅测试引用）。
 * Claude Code 对标方向下保留为可选/遗留视觉资产，最终去留待产品决定。
 *
 * 渲染结构：
 * · 消息 Markdown 第一行    (助手标记，assistantColor)
 *   消息后续行             (缩进对齐，中性正文，自动换行减 2 列宽)
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { formatMarkdown } from './markdown.js'

export interface FormatAssistantMessageInput {
  /** 消息 Markdown 文本 */
  content: string
  /** 终端宽度 */
  width: number
}

const MAX_STATIC_LINES = 200

export function formatAssistantMessage(input: FormatAssistantMessageInput, theme: RivetTheme): string[] {
  if (!input.content || input.content.trim().length === 0) return []

  const lines: string[] = []
  const contentLines = input.content.split('\n')
  const isLong = contentLines.length > MAX_STATIC_LINES

  // 省略提示
  if (isLong) {
    const omitted = contentLines.length - MAX_STATIC_LINES
    lines.push(color(`(… ${omitted} earlier lines omitted)`, theme.muted))
  }

  // Markdown 渲染：使用 formatMarkdown 做完整排版 + 语法高亮
  const displayContent = isLong
    ? contentLines.slice(-MAX_STATIC_LINES).join('\n')
    : input.content

  // 宽度减去 2 列给缩进预留空间，避免终端自动折行
  const rendered = formatMarkdown({ text: displayContent, columns: input.width - 2 }, theme)

  if (rendered.length > 0) {
    const useAscii = chalk.level < 3
    const marker = useAscii ? '*' : '·'
    // 首行前缀带助手标记，其余缩进 2 空格
    lines.push(`${color(marker, theme.assistantColor, { bold: true })} ${rendered[0]}`)
    for (let i = 1; i < rendered.length; i++) {
      lines.push(`  ${rendered[i]}`)
    }
  }

  return lines
}
