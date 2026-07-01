/**
 * T9 格式化函数 — 首屏欢迎（带边框与大标识品牌设计）。
 *
 * 渲染结构：
 *   ┌────────────────────────────────────────────────────────────────────────┐
 *   │                                                                        │
 *   │                         ●                   ·                          │
 *   │                                 ·     ·                                │
 *   │                           ·                     ·                      │
 *   │                                  ·                                     │
 *   │                                                                        │
 *   │    ████████╗██╗ █████╗ ███╗   ██╗███████╗██╗  ██╗██╗   ██╗             │
 *   │    ╚══██╔══╝██║██╔══██╗████╗  ██║██╔════╝██║  ██║██║   ██║             │
 *   │       ██║   ██║███████║██╔██╗ ██║███████╗███████║██║   ██║             │
 *   │       ██║   ██║██╔══██║██║╚██╗██║╚════██║██╔══██║██║   ██║             │
 *   │       ██║   ██║██║  ██║██║ ╚████║███████║██║  ██║╚██████╔╝             │
 *   │       ╚═╝   ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝              │
 *   │                                                                        │
 *   │                              天 枢  ·  #5569                            │
 *   │                                                                        │
 *   │               deepseek-v4  ·  opencode-tui/  ·  2fe31f42               │
 *   │                                                                        │
 *   │     Ctrl+C interrupt      Ctrl+Esc palette      Ctrl+R history         │
 *   │     Ctrl+O expand         Ctrl+T thinking       Esc Esc rewind         │
 *   │     /help commands        \+Enter / Ctrl+J multi-line                  │
 *   │                                                                        │
 *   └────────────────────────────────────────────────────────────────────────┘
 */

import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'

/** 宽度口径：与终端一致（CJK 终端把 `·` 等 ambiguous 符号按 2 列渲染）。欢迎屏
 *  含"天枢"(CJK) 与大量 `·` 分隔符，narrow(stringWidth) 居中 padding 会偏 → CJK
 *  终端下右侧边框不齐。…/· 恒按 2 列参与截断与居中预算。 */
const WIDE = { ambiguousAsWide: true }

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). When present, shown in the title. */
  numericId?: number
  /** 折叠为单行极简版（用于非首次启动/恢复会话）。 */
  compact?: boolean
}

function truncateToWidth(text: string, maxWidth: number): string {
  // … 自身按 2 列计，预留其宽度后截断剩余文本。
  const ellW = displayWidth('…', WIDE)
  return displayWidth(text, WIDE) > maxWidth
    ? `${truncateToDisplayWidth(text, Math.max(0, maxWidth - ellW), WIDE)}…`
    : text
}

function centerLine(text: string, width: number): string {
  const w = displayWidth(text, WIDE)
  if (w >= width) return text
  const left = Math.floor((width - w) / 2)
  const right = width - w - left
  return ' '.repeat(left) + text + ' '.repeat(right)
}

// 极简天枢主星与星芒光晕 (宽度 20)
const STAR_TEMPLATE = [
  "         .",
  "       \\ | /",
  "     - - ✦ - -",
  "       / | \\",
  "         ."
]
const STAR_ROWS = 5

function renderStarRow(rowIdx: number, theme: RivetTheme): string {
  const line = STAR_TEMPLATE[rowIdx]
  if (!line) return ''
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]
    if (char === '✦') {
      // 天枢星心 — 极亮且带闪烁/高亮
      out += color('✦', theme.pulseAlert || theme.userColor, { bold: true })
    } else if (char === '.') {
      // 边缘散发光晕的点 — 极暗色
      out += color('.', theme.dim)
    } else if (char !== ' ') {
      // 放射星芒线 — 使用主色高亮
      out += color(char, theme.primary)
    } else {
      out += ' '
    }
  }
  return out
}

// TIANSHU 大字 Block ASCII 标识 (6行高，55列宽)
const BRAND_LOGO = [
  "  ______ _                 _",
  " /_  __/(_)___ _____  ____| |__  __  __",
  "  / /  / / __ `/ __ \\/ ___/ __ \\/ / / /",
  " / /  / / /_/ / / / (__  ) / / / /_/ /",
  "/_/  /_/\\__,_/_/ /_/____/_/ /_/\\__,_/"
]

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)

  // 折叠模式：单行极简提示，适合恢复会话或非首次启动
  if (input.compact) {
    const numeric = input.numericId ? ` · #${input.numericId}` : ''
    const line = `${color('✦', theme.primary, { bold: true })} ${color('天枢', theme.primary, { bold: true })}${numeric}  ${color('·', theme.dim)}  ${color(input.modelName, theme.secondary)}  ${color('·', theme.dim)}  ${color(dir + '/', theme.dim)}  ${color('·', theme.dim)}  ${color(session, theme.dim)}  ${color('·', theme.dim)}  ${color('/help', theme.secondary)}`
    return [truncateToWidth(line, cols)]
  }

  const boxWidth = Math.min(80, cols)

  // 如果列宽足够，渲染精致的带边框卡片
  if (boxWidth >= 60) {
    const innerWidth = boxWidth - 4
    const borderCol = (text: string) => color(text, theme.dim)
    const out: string[] = []

    // 格式化带边框的行
    const wrapLine = (content: string) => {
      return borderCol('│') + ' ' + centerLine(content, innerWidth) + ' ' + borderCol('│')
    }

    out.push(borderCol('┌' + '─'.repeat(boxWidth - 2) + '┐'))
    out.push(wrapLine(''))

    // 1. 天枢主星与星芒光晕
    for (let r = 0; r < STAR_ROWS; r++) {
      out.push(wrapLine(renderStarRow(r, theme)))
    }
    out.push(wrapLine(''))

    // 2. 大字品牌标识
    for (const line of BRAND_LOGO) {
      out.push(wrapLine(color(line, theme.primary, { bold: true })))
    }
    out.push(wrapLine(''))

    // 3. 中文副标题
    let subText = color('天 枢', theme.primary, { bold: true })
    if (input.numericId) {
      subText += `  ${color('·', theme.dim)}  ${color(`#${input.numericId}`, theme.primary, { bold: true })}`
    }
    out.push(wrapLine(subText))
    out.push(wrapLine(''))

    // 4. 元信息
    const metaText = `${color(input.modelName, theme.secondary || theme.muted)}  ${color('·', theme.dim)}  ${color(dir + '/', theme.dim)}  ${color('·', theme.dim)}  ${color(session, theme.dim)}`
    out.push(wrapLine(metaText))
    out.push(wrapLine(''))

    // 5. 快捷键
    const sep = '    '
    const shortcutLine1 = color(`Ctrl+C interrupt${sep}Ctrl+Esc palette${sep}Ctrl+R history`, theme.dim)
    const shortcutLine2 = color(`Ctrl+O expand${sep}Ctrl+T thinking${sep}Esc Esc rewind`, theme.dim)
    const shortcutLine3 = color(`/help commands${sep}\\+Enter / Ctrl+J multi-line`, theme.dim)

    out.push(wrapLine(shortcutLine1))
    out.push(wrapLine(shortcutLine2))
    out.push(wrapLine(shortcutLine3))
    out.push(wrapLine(''))

    out.push(borderCol('└' + '─'.repeat(boxWidth - 2) + '┘'))

    return out.map(line => truncateToWidth(line, cols))
  }

  // 极窄终端降级为极简无边框排版
  const out: string[] = []
  const starGlyph = color('✦', theme.pulseAlert || theme.userColor)
  out.push(`${starGlyph}  ${color('T I A N S H U', theme.primary, { bold: true })}  ${starGlyph}`)
  out.push(color(`天 枢`, theme.secondary || theme.muted))
  out.push(color(`${input.modelName} · ${dir}/ · ${session}`, theme.dim))
  out.push('')
  out.push(color('Ctrl+C interrupt    Ctrl+Esc palette    Ctrl+R history', theme.dim))
  out.push(color('Ctrl+O expand       Ctrl+T thinking     Esc Esc rewind', theme.dim))
  out.push(color('/help commands      \\+Enter / Ctrl+J multi-line', theme.dim))

  return out.map(line => truncateToWidth(line, cols))
}
