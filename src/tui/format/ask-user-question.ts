/**
 * ask_user_question 的模态化渲染。
 *
 * 把模型对用户的提问从普通工具卡片流中提取出来，用带边框的卡片高亮展示，
 * 确保问题和所有选项都完整可见，不被后续工具输出淹没。
 *
 * 渲染结构：
 *   ┌────────────────────────────────────────┐
 *   │ ? 需要你的回答                         │
 *   ├────────────────────────────────────────┤
 *   │ Which provider do you want?            │
 *   │                                        │
 *   │   1. OpenAI                            │
 *   │   2. Anthropic                         │
 *   └────────────────────────────────────────┘
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

const MIN_BOX_WIDTH = 40
const DEFAULT_BOX_WIDTH = 80
const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g

/** 去掉 ANSI 转义后的纯文本长度。 */
function plainLength(text: string): number {
  return text.replace(ANSI_RE, '').length
}

/** 把一段文本按目标显示宽度折成多行，保留已有换行。 */
function wrapLines(text: string, width: number): string[] {
  const out: string[] = []
  for (const rawLine of text.split('\n')) {
    if (displayWidth(rawLine) <= width) {
      out.push(rawLine)
      continue
    }
    let current = ''
    let currentWidth = 0
    for (const ch of rawLine) {
      const cp = ch.codePointAt(0) ?? 0
      const chWidth = displayWidth(String.fromCodePoint(cp))
      if (currentWidth + chWidth > width && current.length > 0) {
        out.push(current)
        current = ch
        currentWidth = chWidth
      } else {
        current += ch
        currentWidth += chWidth
      }
    }
    if (current.length > 0) out.push(current)
  }
  return out
}

/** 左对齐填充或截断到目标宽度（ANSI 安全）。 */
function fitLine(text: string, width: number): string {
  const plain = text.replace(ANSI_RE, '')
  const pad = width - displayWidth(plain)
  if (pad < 0) return truncateToDisplayWidth(text, width)
  if (pad === 0) return text
  return text + ' '.repeat(pad)
}

export interface FormatAskUserQuestionInput {
  content: string
  columns?: number
}

export function formatAskUserQuestion(input: FormatAskUserQuestionInput, theme: RivetTheme): string[] {
  const cols = input.columns ?? DEFAULT_BOX_WIDTH
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(DEFAULT_BOX_WIDTH, cols))
  const innerWidth = boxWidth - 4

  const borderCol = (text: string) => color(text, theme.warning)
  const title = color('? 需要你的回答', theme.warning, { bold: true })

  const lines: string[] = []
  lines.push(borderCol('┌' + '─'.repeat(boxWidth - 2) + '┐'))
  lines.push(borderCol('│') + ' ' + fitLine(title, innerWidth) + ' ' + borderCol('│'))
  lines.push(borderCol('├' + '─'.repeat(boxWidth - 2) + '┤'))

  const contentLines = wrapLines(input.content, innerWidth)
  for (const line of contentLines) {
    lines.push(borderCol('│') + ' ' + fitLine(line, innerWidth) + ' ' + borderCol('│'))
  }

  lines.push(borderCol('└' + '─'.repeat(boxWidth - 2) + '┘'))
  return lines
}

/** 判断 ask_user_question 内容是否需要在终端宽度下折行。 */
export function isAskUserQuestionWrapped(content: string, columns?: number): boolean {
  const cols = columns ?? DEFAULT_BOX_WIDTH
  const boxWidth = Math.max(MIN_BOX_WIDTH, Math.min(DEFAULT_BOX_WIDTH, cols))
  const innerWidth = boxWidth - 4
  return wrapLines(content, innerWidth).length > content.split('\n').length
}
