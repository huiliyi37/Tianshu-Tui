/**
 * T9 格式化函数 — 首屏欢迎（Dawn / 启明星风格卡片）。
 *
 * 目标样式：
 * - 左侧是一枚纵向“启明星”图腾：单一主星 + 向下的光柱 / 地平线倒影。
 * - 标题使用暖金色，副标题使用雾灰色。
 * - 信息区从标题列起始位置对齐，整体更接近设计稿。
 * - 去掉标题旁边的四个小星星，只保留左侧主图腾。
 */

import { homedir } from 'node:os'
import { color } from '../engine/ansi.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import type { RivetTheme } from '../theme.js'

/** 宽度口径：与终端一致（CJK 终端把 `·`/`✦` 等 ambiguous 符号按 2 列渲染）。 */
const WIDE = { ambiguousAsWide: true }

export interface FormatWelcomeInput {
  modelName: string
  cwd: string
  sessionId: string
  priorMsgCount: number
  columns: number
  /** Ephemeral per-session numeric id (e.g. 7281). Shown in compact mode. */
  numericId?: number
  /** 折叠为单行极简版（用于非首次启动/恢复会话）。 */
  compact?: boolean
  /** 终端可视高度（行）。极矮终端降级为 compact 单行。 */
  rows?: number
  /** Tianshu Code 版本号（来自安装根 package.json），无则不显示。 */
  version?: string | null
  /** 当前权限模式（auto-safe / manual / dangerously-skip-permissions …）。 */
  approvalMode?: string
}

/** 头图 + 卡片 + 输入框 + 状态栏最低保留。 */
const BANNER_ROWS = 8
const RESERVED_ROWS = 5

function truncateToWidth(text: string, maxWidth: number): string {
  const ellW = displayWidth('…', WIDE)
  return displayWidth(text, WIDE) > maxWidth
    ? `${truncateToDisplayWidth(text, Math.max(0, maxWidth - ellW), WIDE)}…`
    : text
}

/** cwd 的 `~` 缩写（Claude Code 同款展示口径）。 */
function tildify(cwd: string): string {
  const home = homedir()
  return home && cwd.startsWith(home) ? `~${cwd.slice(home.length)}` : cwd
}

function makeLogoLines(theme: RivetTheme): string[] {
  const moonCol = (s: string) => color(s, theme.secondary)
  const starCol = (s: string) => color(s, theme.primary, { bold: true })
  
  const line1 = `  ${moonCol('▄██')}`
  const line2 = ` ${moonCol('▐█▀')} ${starCol('✦')}`
  const line3 = `  ${moonCol('▀██')}`
  
  const w1 = displayWidth('  ▄██', WIDE)
  const w2 = displayWidth(' ▐█▀ ✦', WIDE)
  const w3 = displayWidth('  ▀██', WIDE)
  
  return [
    line1 + ' '.repeat(Math.max(0, 10 - w1)),
    line2 + ' '.repeat(Math.max(0, 10 - w2)),
    line3 + ' '.repeat(Math.max(0, 10 - w3)),
  ]
}

export function formatWelcome(input: FormatWelcomeInput, theme: RivetTheme): string[] {
  const cols = input.columns > 0 ? input.columns : 80

  const dir = input.cwd.replace(/^.*\//, '')
  const session = input.priorMsgCount > 0
    ? `${input.sessionId.slice(0, 8)} (${input.priorMsgCount} prior)`
    : input.sessionId.slice(0, 8)

  const compactLine = (): string => {
    const numeric = input.numericId ? ` · #${input.numericId}` : ''
    const line = `${color('✦', theme.primary, { bold: true })} ${color('天枢', theme.primary, { bold: true })}${numeric}  ${color('·', theme.dim)}  ${color(input.modelName, theme.secondary)}  ${color('·', theme.dim)}  ${color(dir + '/', theme.muted)}  ${color('·', theme.dim)}  ${color(session, theme.muted)}  ${color('·', theme.dim)}  ${color('/help', theme.secondary)}`
    return truncateToWidth(line, cols)
  }

  if (input.compact) {
    return [compactLine()]
  }

  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  if (rows < BANNER_ROWS + RESERVED_ROWS) {
    return [compactLine()]
  }

  const W = cols - 2
  if (W < 56) {
    return [compactLine()]
  }

  const innerW = W - 4
  const logoLines = makeLogoLines(theme)
  const logoW = 10
  const gapW = 2
  const textW = innerW - logoW - gapW
  const borderCol = (s: string) => color(s, theme.primary)

  const titlePlain = 'Welcome to Tianshu Code!'
  const subtitlePlain = 'Send /help for help information.'
  const title = color(titlePlain, theme.secondary, { bold: true })
  const subtitle = color(subtitlePlain, theme.muted)

  const cardLines: string[] = []
  cardLines.push(borderCol(`┌${'─'.repeat(W - 2)}┐`))

  for (let i = 0; i < logoLines.length; i++) {
    const rightPlain = i === 0 ? titlePlain : i === 1 ? subtitlePlain : ''
    const rightColored = i === 0 ? title : i === 1 ? subtitle : ''
    const pad = ' '.repeat(Math.max(0, textW - displayWidth(rightPlain, WIDE)))
    cardLines.push(`${borderCol('│')} ${logoLines[i]}${' '.repeat(gapW)}${rightColored}${pad} ${borderCol('│')}`)
  }

  const infoRows: { key: string; val: string }[] = [
    { key: 'Directory', val: tildify(input.cwd) },
    { key: 'Session', val: input.sessionId },
    { key: 'Model', val: input.modelName },
  ]
  if (input.version) {
    infoRows.push({ key: 'Version', val: 'v' + input.version })
  }
  if (input.approvalMode) {
    const label = input.approvalMode === 'dangerously-skip-permissions' ? 'yolo' : input.approvalMode
    infoRows.push({ key: 'Approval', val: label })
  }

  const infoIndent = ' '.repeat(logoW + gapW)
  const infoIndentW = displayWidth(infoIndent, WIDE)
  const keyW = 13
  const maxValW = Math.max(8, innerW - infoIndentW - keyW)

  for (const row of infoRows) {
    const keyStr = `${row.key}: `.padEnd(keyW)
    const keyColored = color(keyStr, theme.muted)
    const valPlain = row.val
    const valTruncated = displayWidth(valPlain, WIDE) > maxValW
      ? `${truncateToDisplayWidth(valPlain, maxValW - 1, WIDE)}…`
      : valPlain
    const valW = displayWidth(valTruncated, WIDE)
    const valColored = color(valTruncated, theme.assistantColor || theme.secondary)
    const pad = ' '.repeat(Math.max(0, maxValW - valW))
    cardLines.push(`${borderCol('│')} ${infoIndent}${keyColored}${valColored}${pad} ${borderCol('│')}`)
  }

  cardLines.push(borderCol(`└${'─'.repeat(W - 2)}┘`))

  const tipPrefix = color('▸ Dawn Mode is ready ', theme.warning, { bold: true })
  const tipSuffix = color('Tianshu Code now runs with high-density adaptive chrome.', theme.muted)

  return [
    '',
    ...cardLines,
    '',
    `  ${tipPrefix}${tipSuffix}`,
    '',
  ]
}