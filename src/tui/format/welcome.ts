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

/** 3 行头 + 输入框 3 行 + 终端底部状态栏/呼吸余量 ~2 行。 */
const BANNER_ROWS = 3
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

  // ── CC 头式 3 行 ──────────────────────────────────────────────
  // 左列：单颗启明星（只在第一行），下两行按其显示宽度留白对齐。
  const prefix = ' ✦   '
  const indent = ' '.repeat(displayWidth(prefix, WIDE))
  const star = ` ${color('✦', theme.primary, { bold: true })}   `

  const brand = color('Tianshu Code', theme.primary, { bold: true })
  const version = input.version ? ` ${color(`v${input.version}`, theme.muted)}` : ''

  const modeSuffix = input.approvalMode
    ? ` ${color('·', theme.dim)} ${color(input.approvalMode, theme.muted)}`
    : ''

  const out: string[] = [
    `${star}${brand}${version}`,
    `${indent}${input.modelName}${modeSuffix}`,
    `${indent}${color(tildify(input.cwd), theme.muted)}`,
  ]

  return out.map(line => truncateToWidth(line, cols))
}
