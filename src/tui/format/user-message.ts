/**
 * T9 格式化函数 — 用户消息（极简）。
 *
 * 渲染结构：
 * ▌ 消息原文第一行    (用户标记，userColor)
 *   消息后续行        (缩进对齐)
 */

import chalk from 'chalk'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatUserMessageInput {
  /** 消息文本内容 */
  content: string
  /** 终端宽度（列数） */
  width: number
}

export function formatUserMessage(input: FormatUserMessageInput, theme: RivetTheme): string[] {
  const lines: string[] = []

  const contentLines = input.content.split('\n')
  const useAscii = chalk.level < 3
  const marker = useAscii ? '❯' : '▌'

  if (contentLines.length > 0) {
    lines.push(`${color(marker, theme.userColor, { bold: true })} ${contentLines[0]}`)
    for (let i = 1; i < contentLines.length; i++) {
      lines.push(`  ${contentLines[i]}`)
    }
  }

  return lines
}
