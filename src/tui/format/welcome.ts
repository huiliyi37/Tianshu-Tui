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
  /** 终端可视高度（行）。用于高度自适应降级：欢迎屏写入 scrollback，太高会把随后
   *  渲染的输入框顶到视口底部（甚至被 Warp/iTerm 底部状态栏遮住半截）。未提供时按
   *  "足够高"处理，保持全banner（兼容不传 rows 的调用点/测试）。 */
  rows?: number
}

/** 全 banner（带边框卡片）实际行数：见文件顶部结构注释。 */
const FULL_BANNER_ROWS = 24
/** 中号（无边框）降级布局行数。 */
const MEDIUM_BANNER_ROWS = 7
/** 紧凑单行模式行数。 */
const COMPACT_BANNER_ROWS = 1
/** 欢迎屏之外必须保持可见的行：输入框 3 行 + 终端底部状态栏/呼吸余量 ~2 行。 */
const RESERVED_ROWS = 5

// ── 宽度分级阈值 ──────────────────────────────────────────────
/** 全量边框卡片最低宽度。 */
const FULL_WIDTH_THRESHOLD = 60
/** 紧凑无边框最低宽度。 */
const COMPACT_WIDTH_THRESHOLD = 30
/** 单行标题最低宽度（至少能放下 "TS v4-pro"）。 */
const MIN_WIDTH_THRESHOLD = 16

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

  // ── 元信息标准化：统一用 | 分隔，超长字段自动截断 ──────────
  const truncateDir = dir.length > 12 ? dir.slice(0, 9) + '…' : dir
  const truncateSession = session.length > 20 ? session.slice(0, 17) + '…' : session
  const normalizedMeta = `${color(input.modelName, theme.secondary || theme.muted)} | ${color(truncateDir + '/', theme.dim)} | ${color(truncateSession, theme.dim)}`

  // ── 快捷键数据 ──────────────────────────────────────────────
  const KEYBOARD_SHORTCUTS: ReadonlyArray<{ key: string; action: string }> = [
    { key: 'Ctrl+C', action: 'interrupt' },
    { key: 'Ctrl+Esc', action: 'palette' },
    { key: 'Ctrl+R', action: 'history' },
    { key: 'Ctrl+O', action: 'expand' },
    { key: 'Ctrl+T', action: 'thinking' },
    { key: 'Esc Esc', action: 'rewind' },
    { key: '/help', action: 'commands' },
    { key: '\\+Enter', action: 'multi-line' },
  ]

  // 关键快捷键（默认显示）
  const KEY_SHORTCUTS_VISIBLE: ReadonlyArray<{ key: string; action: string }> = [
    { key: 'Ctrl+C', action: 'interrupt' },
    { key: 'Ctrl+R', action: 'history' },
    { key: '/help', action: 'commands' },
    { key: '\\+Enter', action: 'multi-line' },
  ]

  const formatShortcutPair = (s: { key: string; action: string }) =>
    color(`${s.key.padEnd(10)}${s.action}`, theme.dim)

  const formatShortcutLine = (shortcuts: typeof KEYBOARD_SHORTCUTS) =>
    shortcuts.map(formatShortcutPair).join('    ')

  const remainingCount = KEYBOARD_SHORTCUTS.length - KEY_SHORTCUTS_VISIBLE.length

  // ── 单行极简模式（最低宽度） ─────────────────────────────────
  const compactLine = (): string => {
    const numeric = input.numericId ? ` · #${input.numericId}` : ''
    const line = `${color('✦', theme.primary, { bold: true })} ${color('天枢', theme.primary, { bold: true })}${numeric}  ${color('·', theme.dim)}  ${color(input.modelName, theme.secondary)}  ${color('·', theme.dim)}  ${color(truncateDir + '/', theme.dim)}  ${color('·', theme.dim)}  ${color(truncateSession, theme.dim)}  ${color('·', theme.dim)}  ${color('/help', theme.secondary)}`
    return truncateToWidth(line, cols)
  }

  // 折叠模式：单行极简提示，适合恢复会话或非首次启动
  if (input.compact) {
    return [compactLine()]
  }

  // 高度自适应：欢迎屏落进 scrollback，其后立即渲染的输入框需留在视口内。
  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  const fitsFull = rows >= FULL_BANNER_ROWS + RESERVED_ROWS
  const fitsMedium = rows >= MEDIUM_BANNER_ROWS + RESERVED_ROWS
  if (!fitsMedium) {
    return [compactLine()]
  }

  const boxWidth = Math.min(80, cols)

  // ── 宽度分级：四级降级 ──────────────────────────────────────

  // === Tier 1: 全量边框卡片（宽 ≥ 60） ===
  if (boxWidth >= FULL_WIDTH_THRESHOLD && fitsFull) {
    const innerWidth = boxWidth - 4
    const borderCol = (text: string) => color(text, theme.dim)
    const out: string[] = []

    const wrapLine = (content: string) => {
      return borderCol('│') + ' ' + centerLine(content, innerWidth) + ' ' + borderCol('│')
    }

    out.push(borderCol('┌' + '─'.repeat(boxWidth - 2) + '┐'))
    out.push(wrapLine(''))

    // 1. 北斗星图（窄屏时缩小为单字符）
    if (boxWidth >= 60) {
      for (let r = 0; r < DIPPER_ROWS; r++) {
        out.push(wrapLine(renderDipperRow(r, theme)))
      }
    } else {
      // 60-79 列：单行星图标记
      out.push(wrapLine(color('✦ ━ 北斗七星 ━', theme.dim)))
    }
    out.push(wrapLine(''))

    // 2. 大字品牌标识（窄屏时替换为单行）
    if (boxWidth >= 60) {
      for (const line of BRAND_LOGO) {
        out.push(wrapLine(renderLogoLine(line, theme)))
      }
    } else {
      // 60-79 列：紧凑单行标题
      let subText = color('天 枢', theme.primary, { bold: true })
      if (input.numericId) {
        subText += `  ${color('·', theme.dim)}  ${color(`#${input.numericId}`, theme.primary, { bold: true })}`
      }
      out.push(wrapLine(subText))
    }
    out.push(wrapLine(''))

    // 3. 中文副标题（仅全量模式）
    if (boxWidth >= 60) {
      let subText = color('天 枢', theme.primary, { bold: true })
      if (input.numericId) {
        subText += `  ${color('·', theme.dim)}  ${color(`#${input.numericId}`, theme.primary, { bold: true })}`
      }
      out.push(wrapLine(subText))
      out.push(wrapLine(''))
    }

    // 4. 元信息（标准化分隔符）
    out.push(wrapLine(normalizedMeta))
    out.push(wrapLine(''))

    // 5. 快捷键（折叠式卡片：默认显示关键项 + "… +N more"）
    out.push(wrapLine(formatShortcutLine(KEY_SHORTCUTS_VISIBLE)))
    if (remainingCount > 0) {
      out.push(wrapLine(color(`… +${remainingCount} more  (press ? for full list)`, theme.dim)))
    }
    out.push(wrapLine(''))

    out.push(borderCol('└' + '─'.repeat(boxWidth - 2) + '┘'))

    return out.map(line => truncateToWidth(line, cols))
  }

  // === Tier 2: 紧凑无边框（30 ≤ 宽 < 60） ===
  if (boxWidth >= COMPACT_WIDTH_THRESHOLD) {
    const starGlyph = color('✦', theme.pulseAlert || theme.userColor)
    const out: string[] = []
    out.push(`${starGlyph}  ${color('天枢', theme.primary, { bold: true })}`)
    if (input.numericId) {
      out.push(color(`# ${input.numericId}  ·  ${input.modelName}`, theme.dim))
    } else {
      out.push(color(input.modelName, theme.dim))
    }
    out.push(color(`| ${truncateDir}/ | ${truncateSession}`, theme.muted))
    out.push('')
    // 关键快捷键（单行排列）
    out.push(color(formatShortcutLine(KEY_SHORTCUTS_VISIBLE), theme.dim))
    if (remainingCount > 0) {
      out.push(color(`… +${remainingCount} more  (? for full list)`, theme.dim))
    }
    return out.map(line => truncateToWidth(line, cols))
  }

  // === Tier 3: 极低宽度（< 30）— 单行标题 ===
  if (rows >= COMPACT_BANNER_ROWS + RESERVED_ROWS) {
    return [compactLine()]
  }

  // 兜底：连单行都放不下
  return [compactLine()]
}
