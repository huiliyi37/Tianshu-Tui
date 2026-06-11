/**
 * T9 格式化函数 — 首屏欢迎。
 *
 * 精简版（≤3 行），替代旧的 11 行双框：
 *   天枢 (Tiānshū) · T9 ANSI TUI
 *   <model> · <cwd> · <session>
 *   /help commands · @ files · Ctrl+C exit
 *
 * 按终端宽度自适应（display-width aware 截断），不再用固定列宽的框线，
 * 避免 CJK / 长 CWD 撑破对齐。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  /** 已恢复的历史消息数（>0 时提示 prior msgs） */
  priorMsgCount: number
  /** 终端列宽 */
  columns: number
}

/** 按显示宽度截断（保留尾部省略号），ANSI-aware 由 string-width 处理。 */
function truncateToWidth(text: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (stringWidth(text) <= maxWidth) return text
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > maxWidth - 1) break
    out += ch
    w += cw
  }
  return out + '…'
}

/** 缩短 CWD：超长时保留尾部（最有信息量的工作目录名）。 */
function shortenCwd(cwd: string, budget: number): string {
  if (cwd.length <= budget) return cwd
  return '…' + cwd.slice(-(budget - 1))
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const title = '天枢 (Tiānshū) · T9 ANSI TUI'

  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)
  const cwd = shortenCwd(input.cwd, 40)
  const meta = `${input.modelName}  ·  ${cwd}  ·  ${session}`

  const hint = '/help commands · @ files · \\⏎ newline · Ctrl+C exit'

  return [
    color(truncateToWidth(title, cols), theme.primary, { bold: true }),
    color(truncateToWidth(meta, cols), theme.muted),
    color(truncateToWidth(hint, cols), theme.dim),
  ]
}
