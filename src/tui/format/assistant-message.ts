/**
 * T9 格式化函数 — assistant 消息。
 *
 * 纯函数，从 `assistant-message.tsx` 的渲染逻辑提取。
 * 输入数据 + 主题色 → ANSI 格式化字符串数组。
 */

import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

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
 * Markdown 内容    (由 markdown 渲染器处理，阶段 2 接入)
 *
 * 注意：阶段 1 的 Markdown 内容以纯文本输出。阶段 2 会接入
 * 纯 ANSI Markdown 渲染器以获得完整的语法高亮和排版。
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

  // 内容（阶段 1：纯文本；阶段 2：Markdown 渲染）
  const displayLines = isLong ? contentLines.slice(-MAX_STATIC_LINES) : contentLines
  for (const line of displayLines) {
    lines.push(color(line, theme.assistantColor))
  }

  return lines
}
