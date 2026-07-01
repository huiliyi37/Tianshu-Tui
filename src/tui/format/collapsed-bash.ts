/**
 * Collapsed Bash Group — 将连续短/非变更型 bash 命令折叠为单行摘要。
 *
 * 触发条件：命令长度 ≤ MAX_COMMAND_LEN 且不命中变更型模式（重定向、rm、cp、git push…）。
 * 连续可折叠 bash 合并为 "Ran N shell commands"；被非 bash 工具、变更型 bash、
 * 或错误结果打断时 flush。
 *
 * 温跃层设计：CollapsedBashBuffer（状态管理）↔ app.ts（事件驱动）。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

// ── Types ──────────────────────────────────────────────────────

export interface CollapsedBashEntry {
  /** tool_use_id */
  id: string
  /** 原始命令 */
  command: string
  /** 输出内容（终态） */
  content?: string
  /** 是否执行失败 */
  isError?: boolean
  /** 终态结果已到达 */
  completed: boolean
  /** 命令开始时间 */
  startMs: number
}

export interface CollapsedBashGroup {
  entries: CollapsedBashEntry[]
  startMs: number
}

// ── Heuristics ─────────────────────────────────────────────────

/** 可折叠命令的最大长度（字符） */
export const MAX_COLLAPSIBLE_COMMAND_LEN = 200

/**
 * 变更型命令/模式。命中任一模式即视为可能修改文件系统/远程状态，不折叠。
 * 设计原则：宁可漏折叠（false negative）也不误折叠变更命令（false positive）。
 */
const MUTATING_PATTERNS: ReadonlyArray<RegExp> = [
  // 输出重定向（>、>>、>&，后接空白或行尾）
  />[&>]*(?:\s|$)/,
  // 文件系统变更
  /\b(rm|cp|mv|mkdir|rmdir|touch|chmod|chown|ln|tee|dd)\b/,
  // git 变更
  /\bgit\s+(commit|push|pull|checkout|merge|rebase|reset|cherry-pick|revert|apply)\b/,
  // 包管理器变更
  /\b(npm|yarn|pnpm|bun)\s+(install|ci|publish|uninstall|remove|add)\b/,
  // sed 就地编辑
  /\bsed\s+(-i|--in-place)\b/,
  // find 删除/执行（-ok 也算执行）
  /\bfind\s+.*(-delete|-exec|-ok)\b/,
  // 构建工具（常写文件）
  /\bmake\b/,
  /\btsc\s+(--build|-b)\b/,
]

/** 判断单个 bash 命令是否可折叠（短且非变更） */
export function isCollapsibleBashCommand(command: string): boolean {
  const trimmed = (command ?? '').trim()
  if (!trimmed) return false
  if (trimmed.length > MAX_COLLAPSIBLE_COMMAND_LEN) return false
  const lower = trimmed.toLowerCase()
  return !MUTATING_PATTERNS.some(p => p.test(lower))
}

// ── Summary ────────────────────────────────────────────────────

export interface BashGroupStats {
  total: number
  completed: number
  pending: number
  failed: number
}

export function computeBashGroupStats(group: CollapsedBashGroup): BashGroupStats {
  let completed = 0
  let pending = 0
  let failed = 0
  for (const entry of group.entries) {
    if (entry.completed) {
      completed++
      if (entry.isError) failed++
    } else {
      pending++
    }
  }
  return { total: group.entries.length, completed, pending, failed }
}

export function buildBashSummaryText(group: CollapsedBashGroup, isActive?: boolean): string {
  const stats = computeBashGroupStats(group)
  if (stats.completed === 0) {
    const parts: string[] = ['…']
    if (isActive && stats.pending > 0) parts.push(`${stats.pending} pending`)
    return parts.join(', ')
  }
  const base = `Ran ${stats.completed} shell command${stats.completed === 1 ? '' : 's'}`
  const parts: string[] = [base]
  if (stats.failed > 0) parts.push(`${stats.failed} failed`)
  if (isActive && stats.pending > 0) parts.push(`${stats.pending} pending`)
  return parts.join(', ')
}

export function buildBashLiveSummaryText(group: CollapsedBashGroup): string {
  const stats = computeBashGroupStats(group)
  if (stats.pending > 0) {
    return `Running ${stats.pending} shell command${stats.pending === 1 ? '' : 's'}`
  }
  return buildBashSummaryText(group, true)
}

// ── Rendering: scrollback ──────────────────────────────────────

export interface FormatCollapsedBashGroupInput {
  group: CollapsedBashGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
}

export function formatCollapsedBashGroup(input: FormatCollapsedBashGroupInput): string[] {
  const { group, expanded, theme } = input
  const lines: string[] = []
  const summary = buildBashSummaryText(group, false)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(1)}s` : `${elapsed}ms`

  // 摘要行：展开状态指示器 + 摘要 + 耗时
  const indicator = expanded ? '▼' : '▶'
  lines.push(color(`${indicator} ${summary} · ${elapsedStr}`, theme.primary))

  const completed = group.entries.filter(e => e.completed)
  if (completed.length === 0) {
    lines.push(color('│  (results pending…)', theme.muted))
    return lines
  }

  if (expanded || completed.length <= 3) {
    for (let i = 0; i < completed.length; i++) {
      const entry = completed[i]!
      const isLast = i === completed.length - 1
      const connector = isLast ? '│  ╰─' : '│  ├─'
      const childPrefix = isLast ? '│     ' : '│  │  '
      const failedMarker = entry.isError ? color(' ✗', theme.error) : ''
      lines.push(`${connector} ${color(entry.command, theme.muted)}${failedMarker}`)
      if (entry.content) {
        const maxWidth = Math.max(10, (input.columns ?? 80) - childPrefix.length)
        const allLines = entry.content.replace(/\n+$/, '').split('\n')
        // 失败：取尾部 3 行（报错原因通常在末尾）并以 error 色高亮；成功：取头部 3 行、muted。
        const previewLines = entry.isError ? allLines.slice(-3) : allLines.slice(0, 3)
        const previewColor = entry.isError ? theme.error : theme.muted
        for (const pl of previewLines) {
          const trimmed = displayWidth(pl) > maxWidth ? truncateToDisplayWidth(pl, maxWidth - 2) + '…' : pl
          lines.push(`${childPrefix}${color(trimmed, previewColor)}`)
        }
        if (allLines.length > 3) {
          const moreNote = entry.isError ? `… +${allLines.length - 3} earlier lines` : `… +${allLines.length - 3} more lines`
          lines.push(color(`${childPrefix}${moreNote}`, theme.muted))
        }
      }
    }
  } else {
    const commands = completed.map(e => e.command).join(', ')
    const maxWidth = Math.max(10, (input.columns ?? 80) - 9)
    const preview = displayWidth(commands) > maxWidth ? truncateToDisplayWidth(commands, maxWidth - 2) + '…' : commands
    lines.push(`│  ╰─ ${color(preview, theme.muted)}`)
    lines.push(color(`│     … +${completed.length - 3} more commands [Ctrl+O]`, theme.secondary))
  }

  return lines
}

// ── Rendering: live region ─────────────────────────────────────

export function formatCollapsedBashGroupLive(
  group: CollapsedBashGroup,
  theme: RivetTheme,
  columns?: number,
): string[] {
  const lines: string[] = []
  const summary = buildBashLiveSummaryText(group)
  const elapsed = Date.now() - group.startMs
  const elapsedStr = elapsed > 1000 ? `${(elapsed / 1000).toFixed(0)}s` : `${elapsed}ms`

  lines.push(`● ${color(summary, theme.muted)} ${color(`· ${elapsedStr}`, theme.muted)}`)

  const lastCompleted = [...group.entries].reverse().find(e => e.content && e.completed && !e.isError)
  if (lastCompleted?.content) {
    const maxWidth = Math.max(10, (columns ?? 80) - 6)
    const tailLines = lastCompleted.content.replace(/\n+$/, '').split('\n').slice(-2)
    for (const line of tailLines) {
      const trimmed = line.length > maxWidth ? line.slice(0, maxWidth - 1) + '…' : line
      lines.push(`  ${color(trimmed, theme.muted)}`)
    }
  }

  return lines
}

// ── Buffer ─────────────────────────────────────────────────────

export class CollapsedBashBuffer {
  private group: CollapsedBashGroup | null = null

  /** 推入一个可折叠 bash 命令；非折叠命令应在外部判 false 后不调此方法 */
  pushUse(id: string, command: string, startMs: number): void {
    if (!this.group) {
      this.group = { entries: [], startMs }
    }
    this.group.entries.push({ id, command, completed: false, startMs })
  }

  attachResult(id: string, content: string, isError?: boolean): CollapsedBashEntry | null {
    if (!this.group) return null
    const entry = this.group.entries.find(e => e.id === id)
    if (!entry) return null
    entry.content = content
    entry.isError = isError ?? false
    entry.completed = true
    return entry
  }

  hasEntry(id: string): boolean {
    return this.group?.entries.some(e => e.id === id) ?? false
  }

  /** 将指定 entry 从组中移除并返回（错误命令需单独渲染为 tool card 时使用） */
  detachEntry(id: string): CollapsedBashEntry | null {
    if (!this.group) return null
    const idx = this.group.entries.findIndex(e => e.id === id)
    if (idx === -1) return null
    const [entry] = this.group.entries.splice(idx, 1)
    if (this.group.entries.length === 0) {
      this.group = null
    }
    return entry ?? null
  }

  flush(): CollapsedBashGroup | null {
    const g = this.group
    this.group = null
    return g
  }

  getActive(): CollapsedBashGroup | null {
    return this.group
  }

  isActive(): boolean {
    return this.group !== null
  }

  hasPending(): boolean {
    return this.group?.entries.some(e => !e.completed) ?? false
  }
}
