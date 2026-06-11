/**
 * T9 格式化函数 — 用户消息。
 *
 * 纯函数，从 `user-message.tsx` 的渲染逻辑提取。
 * 输入数据 + 主题色 → ANSI 格式化字符串数组（每行一个元素）。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatUserMessageInput {
  /** 消息文本内容 */
  content: string
  /** 终端宽度（列数），用于分隔线 */
  width: number
}

/**
 * 格式化用户消息为 ANSI 行数组。
 *
 * 渲染结构：
 * ───────────────── (dim 分隔线)
 * ▍ You           (粗体 gutter + 标签，userColor — 唯一朱砂落点)
 * 消息原文         (终端默认前景色 — 水墨原则：层级靠留白不靠满屏着色)
 */
export function formatUserMessage(input: FormatUserMessageInput, theme: RivetTheme): string[] {
  const lines: string[] = []

  // 分隔线
  lines.push(color('─'.repeat(input.width), theme.dim))

  // Gutter + 标签 —— 朱砂印只落在这一行
  lines.push(`${color('▍', theme.userColor, { bold: true })} ${color('You', theme.userColor, { dim: true })}`)

  // 消息内容 —— 中性正文，不着 accent 色（避免整段朱砂红墙）
  for (const line of input.content.split('\n')) {
    lines.push(line)
  }

  return lines
}
