/**
 * T9 格式化函数 — 首屏欢迎（极简）。
 *
 * 渲染结构：
 *   Tianshu
 *   <model> · <dir> · <session>
 *   Ctrl+C interrupt    Ctrl+Esc palette    Ctrl+R history
 *   Ctrl+O expand       Ctrl+T thinking     Esc Esc rewind
 *   /help commands      \+Enter / Ctrl+J multi-line
 *
 * 快捷键须与 engine/app.ts + input-line.ts 实际键位一致（曾漂移成 Ctrl+K/Alt+Enter）。
 */

import stringWidth from 'string-width'
import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). When present, shown in the title. */
  numericId?: number
}

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

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80
  const out: string[] = []

  out.push(color('Tianshu', theme.primary, { bold: true }))
  if (input.numericId) {
    out[0] = color(`Tianshu · #${input.numericId}`, theme.primary, { bold: true })
  }

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)
  out.push(color(`${input.modelName} · ${dir}/ · ${session}`, theme.dim))
  out.push('')
  out.push(color('Ctrl+C interrupt    Ctrl+Esc palette    Ctrl+R history', theme.dim))
  out.push(color('Ctrl+O expand       Ctrl+T thinking     Esc Esc rewind', theme.dim))
  out.push(color('/help commands      \\+Enter / Ctrl+J multi-line', theme.dim))

  return out.map(line => truncateToWidth(line, cols))
}
