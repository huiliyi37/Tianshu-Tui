/**
 * T9 格式化函数 — assistant 消息。
 *
 * 纯函数，从 `assistant-message.tsx` 的渲染逻辑提取。
 * 输入数据 + 主题色 → ANSI 格式化字符串数组。
 */

import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { formatMarkdown } from './markdown.js'

export interface FormatAssistantMessageInput {
  /** 消息 Markdown 文本 */
  content: string
  /** 终端宽度 */
  width: number
}

const MAX_STATIC_LINES = 200

/**
 * 格式化 assistant 消息为 ANSI 行数组。
 *
 * 渲染结构：
 * ▍ Rivet         (粗体 gutter + 标签，assistantColor)
 * (…N lines omitted)  (如果超长，muted)
 * Markdown 内容    (完整 Markdown 渲染：语法高亮、标题、列表、代码块等)
 */
export function formatAssistantMessage(input: FormatAssistantMessageInput, theme: RivetTheme): string[] {
  if (!input.content || input.content.trim().length === 0) return []

  const lines: string[] = []
  const contentLines = input.content.split('\n')
  const isLong = contentLines.length > MAX_STATIC_LINES

  // Gutter + 标签
  lines.push(`${color('▍', theme.assistantColor, { bold: true })} ${color('Rivet', theme.assistantColor, { dim: true })}`)

  // 省略提示
  if (isLong) {
    const omitted = contentLines.length - MAX_STATIC_LINES
    lines.push(color(`(… ${omitted} earlier lines omitted)`, theme.muted))
  }

  // Markdown 渲染：使用 formatMarkdown 做完整排版 + 语法高亮
  const displayContent = isLong
    ? contentLines.slice(-MAX_STATIC_LINES).join('\n')
    : input.content
  const rendered = formatMarkdown({ text: displayContent, columns: input.width }, theme)
  lines.push(...rendered)

  return lines
}
