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

// 北斗七星 — 真实勺形布局
const DIPPER_STARS: ReadonlyArray<{ x: number; y: number; lead?: boolean }> = [
  { x: 4, y: 0, lead: true }, // 天枢 — 勺口·上 (Dubhe)
  { x: 4, y: 2 },             // 天璇 — 勺口·下 (Merak)
  { x: 10, y: 3 },            // 天玑 — 勺底·下 (Phecda)
  { x: 11, y: 1 },            // 天权 — 勺底·上 (Megrez)
  { x: 16, y: 1 },            // 玉衡 — 柄 (Alioth)
  { x: 21, y: 1 },            // 开阳 — 柄 (Mizar)
  { x: 25, y: 0 },            // 摇光 — 柄端 (Alkaid)
]
const DIPPER_WIDTH = 26
const DIPPER_ROWS = 4

function renderDipperRow(rowIdx: number, theme: RivetTheme): string {
  let out = ''
  for (let colIdx = 0; colIdx < DIPPER_WIDTH; colIdx++) {
    const star = DIPPER_STARS.find(s => s.y === rowIdx && s.x === colIdx)
    if (star) {
      if (star.lead) {
        out += color('●', theme.pulseAlert || theme.userColor, { bold: true })
      } else {
        out += color('·', theme.dim)
      }
    } else {
      out += ' '
    }
  }
  return out
}

// TIANSHU 大字 Block ASCII 标识 (6行高，55列宽)
const BRAND_LOGO = [
  '████████╗██╗ █████╗ ███╗   ██╗███████╗██╗  ██╗██╗   ██╗',
  '╚══██╔══╝██║██╔══██╗████╗  ██║██╔════╝██║  ██║██║   ██║',
  '   ██║   ██║███████║██╔██╗ ██║███████╗███████║██║   ██║',
  '   ██║   ██║██╔══██║██║╚██╗██║╚════██║██╔══██║██║   ██║',
  '   ██║   ██║██║  ██║██║ ╚████║███████║██║  ██║╚██████╔╝',
  '   ╚═╝   ╚═╝╚═╝  ╚═╝╚═╝  ╚═══╝╚══════╝╚═╝  ╚═╝ ╚═════╝'
]

// 渲染具有立体描边质感的大字 Logo 行
function renderLogoLine(line: string, theme: RivetTheme): string {
  let out = ''
  for (let i = 0; i < line.length; i++) {
    const char = line[i]!
    if (char === '█') {
      // 实体笔画：高亮 primary 色
      out += color('█', theme.primary, { bold: true })
    } else if (char === ' ' || char === '\n') {
      out += char
    } else {
      // 描边线框：使用 secondary/dim 色以形成双色霓虹立体感
      out += color(char, theme.secondary || theme.dim)
    }
  }
  return out
}

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

    // 1. 北斗星图
    for (let r = 0; r < DIPPER_ROWS; r++) {
      out.push(wrapLine(renderDipperRow(r, theme)))
    }
    out.push(wrapLine(''))

    // 2. 大字品牌标识 (采用 3D 双色描边效果)
    for (const line of BRAND_LOGO) {
      out.push(wrapLine(renderLogoLine(line, theme)))
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
