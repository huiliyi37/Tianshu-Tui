/**
 * T9 格式化函数 — 首屏欢迎（Claude Code v2 头部样式：3 行紧凑头）。
 *
 * 渲染结构：
 *    ✦   Tianshu Code v2.15.1
 *        deepseek-v4 · auto-safe
 *        ~/app/deepseek-tui/opencode-tui
 *
 * 无边框、无大字 logo、无快捷键矩阵——欢迎屏只回答三个问题：
 * 这是什么（品牌+版本）、现在什么配置（模型+权限）、在哪里（cwd）。
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

/** 3 行头 + 前后空行 2 行 + 输入框 3 行 + 终端底部状态栏/呼吸余量 ~2 行。 */
const BANNER_ROWS = 5
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

  // 折叠模式：单行极简提示，适合恢复会话或非首次启动
  if (input.compact) {
    return [compactLine()]
  }

  // 高度自适应：极矮终端（放不下 3 行头 + 输入框）退单行。
  const rows = input.rows && input.rows > 0 ? input.rows : Number.POSITIVE_INFINITY
  if (rows < BANNER_ROWS + RESERVED_ROWS) {
    return [compactLine()]
  }

  // ── Kimi Code 风格包裹卡片 ────────────────────────────────────
  const W = Math.min(cols - 4, 76)
  if (W < 45) {
    return [compactLine()]
  }

  const innerW = W - 4
  const logoW = 11
  const infoW = innerW - logoW

  const logoLines = [
    `    ${color('▲', theme.primary)}     `,
    `  ${color('◄', theme.primary)} ${color('✦', theme.primary, { bold: true })} ${color('►', theme.primary)} `,
    `    ${color('▼', theme.primary)}     `,
  ]

  const rightLines = [
    color('Welcome to Tianshu Code!', theme.primary, { bold: true }),
    color('Send /help for help information.', theme.muted),
    '', // 空行
  ]

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

  const borderCol = (s: string) => color(s, theme.primary)

  const cardLines: string[] = []
  cardLines.push(borderCol(`┌${'─'.repeat(W - 2)}┐`))

  for (let i = 0; i < 3; i++) {
    const logo = logoLines[i]!
    const right = rightLines[i]!
    const rightPlain = i === 0 ? 'Welcome to Tianshu Code!' : i === 1 ? 'Send /help for help information.' : ''
    const rightW = displayWidth(rightPlain, WIDE)
    const pad = ' '.repeat(Math.max(0, infoW - rightW))
    cardLines.push(`${borderCol('│')} ${logo}${right}${pad} ${borderCol('│')}`)
  }

  for (const row of infoRows) {
    const keyStr = `  ${row.key}:`
    const keyColored = color(keyStr.padEnd(12), theme.muted)

    const maxValW = innerW - 12
    const valPlain = row.val
    const valTruncated = displayWidth(valPlain, WIDE) > maxValW
      ? `${truncateToDisplayWidth(valPlain, maxValW - 1, WIDE)}…`
      : valPlain
    const valW = displayWidth(valTruncated, WIDE)
    const valColored = color(valTruncated, theme.secondary)
    const pad = ' '.repeat(Math.max(0, maxValW - valW))

    cardLines.push(`${borderCol('│')} ${keyColored}${valColored}${pad} ${borderCol('│')}`)
  }

  cardLines.push(borderCol(`└${'─'.repeat(W - 2)}┘`))

  return [
    '',
    ...cardLines,
    '',
  ]
}
