/**
 * T9 格式化函数 — 用户消息（强调导轨，正文保持中性）。
 *
 * 渲染结构：
 * ▌ 消息首行             (userColor + bold 导轨；regular 中性正文)
 * ▌ 消息后续行           (同一导轨；regular 中性正文)
 * ▌
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
  const prefix = color(marker, theme.userColor, { bold: true })

  if (contentLines.length > 0) {
    // Accent 只承担说话人识别；正文回归中性色，避免长消息整段发亮。
    lines.push(`${prefix} ${color(contentLines[0]!, theme.assistantColor)}`)
    
    // 后续行维持相同正文层级，空行只保留导轨。
    for (let i = 1; i < contentLines.length; i++) {
      const lineText = contentLines[i]!
      if (lineText.trim().length === 0) {
        lines.push(`${prefix}`)
      } else {
        lines.push(`${prefix} ${color(lineText, theme.assistantColor)}`)
      }
    }
  }

  return lines
}
