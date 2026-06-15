/**
 * T9 Overlay 渲染函数 — 纯 ANSI 格式化。
 *
 * 每个 overlay 是一个 `render(width, height, data, theme): string[]` 纯函数，
 * 返回 ANSI 格式化后的行数组。由 OverlayEngine 在 alternate screen buffer 中渲染。
 *
 * 支持的 overlays：
 * - Pager — 分页查看器（大段文本浏览）
 * - Starmap — 星域总览
 * - CommandPalette — 命令面板
 * - Chronicle — 会话历史
 */

import stringWidth from 'string-width'
import { ANSI, color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'

// ── Shared Layout Helpers ─────────────────────────────────────

function formatBorder(width: number, theme: RivetTheme): string {
  return color('┌' + '─'.repeat(width - 2) + '┐', theme.dim)
}

function formatBottomBorder(width: number, theme: RivetTheme): string {
  return color('└' + '─'.repeat(width - 2) + '┘', theme.dim)
}

function formatTitleBar(title: string, width: number, theme: RivetTheme): string {
  const padded = ` ${title} `
  // stringWidth, not .length: CJK/emoji titles occupy 2 cells each, so .length
  // under-counts and the border drifts right of the box edge.
  const remaining = Math.max(0, width - 2 - stringWidth(padded))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│' + ' '.repeat(left) + padded + ' '.repeat(right) + '│', theme.dim)
}

function formatFooter(hint: string, width: number, theme: RivetTheme): string {
  const padded = ` ${hint} `
  const remaining = width - 2 - stringWidth(padded)
  return color('│' + padded + ' '.repeat(Math.max(0, remaining)) + '│', theme.dim)
}

function padLine(text: string, width: number, theme: RivetTheme): string {
  // stringWidth handles ANSI stripping AND CJK/emoji cell width; the old
  // `visible.length` under-padded any line with wide chars, misaligning the ┃ edge.
  const padding = Math.max(0, width - 2 - stringWidth(text))
  return color('│', theme.dim) + text + ' '.repeat(padding) + color('│', theme.dim)
}

// ── Pager ─────────────────────────────────────────────────────

export interface PagerData {
  /** 要显示的文本内容 */
  content: string
  /** 当前页码（0-based） */
  page: number
  /** 标题 */
  title?: string
}

/**
 * 渲染 Pager overlay（分页文本查看器）。
 */
export function renderPager(data: PagerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const contentLines = data.content.split('\n')
  const pageSize = height - 4 // 1 border top + 1 title + 1 footer + 1 border bottom = 4
  const totalPages = Math.max(1, Math.ceil(contentLines.length / pageSize))
  const safePage = Math.min(data.page, totalPages - 1)

  // Top border + title
  lines.push(formatBorder(width, theme))
  const title = data.title ? `${data.title} (${safePage + 1}/${totalPages})` : `Page ${safePage + 1}/${totalPages}`
  lines.push(formatTitleBar(title, width, theme))

  // Content
  const start = safePage * pageSize
  const pageLines = contentLines.slice(start, start + pageSize)
  for (const line of pageLines) {
    lines.push(padLine(line, width, theme))
  }
  // Pad remaining
  for (let i = pageLines.length; i < pageSize; i++) {
    lines.push(padLine('', width, theme))
  }

  // Footer + bottom border
  lines.push(formatFooter('↑↓ scroll  q quit', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── Starmap ───────────────────────────────────────────────────

export interface StarmapEntry {
  /** 星域名称 */
  name: string
  /** 星域标识 glyph */
  glyph: string
  /** 描述 */
  description: string
  /** 是否活跃 */
  active: boolean
  /** 最近活跃时间描述 */
  lastActive?: string
}

export interface StarmapData {
  entries: StarmapEntry[]
  title?: string
  /**
   * Optional project-constellation milestone layer (pre-formatted, ANSI-free
   * one-liners). Rendered as a footer block below the star-domain list. This is
   * render-only data — never injected into the model context / prefix cache.
   */
  milestones?: string[]
  /** Optional cross-session "kindred agent" recognition line. */
  recognitionLine?: string
}

/**
 * 渲染 Starmap overlay（星域/星君总览）。
 *
 * 双层：上层星域总览，下层（可选）项目星座里程碑时间线 + 跨会话辨认行。
 */
export function renderStarmap(data: StarmapData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(data.title ?? '❂ 星域总览 Starmap', width, theme))

  // Column widths
  const glyphWidth = 4
  const nameWidth = Math.min(20, Math.floor(width * 0.25))
  const descWidth = width - 2 - glyphWidth - nameWidth - 8 // 8 for padding/spacing

  // ── Milestone layer budget ──────────────────────────────────────
  const milestones = data.milestones ?? []
  const recognition = data.recognitionLine
  // header(1) + up to 5 milestone lines + recognition(0/1)
  const milestoneRows = milestones.length > 0
    ? 1 + Math.min(5, milestones.length) + (recognition ? 1 : 0)
    : (recognition ? 1 : 0)

  // List entries (shrunk to make room for the milestone layer)
  const maxEntries = Math.max(1, height - 6 - milestoneRows)
  const visible = data.entries.slice(0, maxEntries)

  for (const entry of visible) {
    const glyph = entry.active
      ? color(` ${entry.glyph} `.padEnd(glyphWidth), theme.primary, { bold: true })
      : color(` ${entry.glyph} `.padEnd(glyphWidth), theme.dim)
    const name = entry.active
      ? color(entry.name.padEnd(nameWidth), theme.primary)
      : color(entry.name.padEnd(nameWidth), theme.dim)
    const desc = entry.active
      ? entry.description.slice(0, descWidth).padEnd(descWidth)
      : color(entry.description.slice(0, descWidth).padEnd(descWidth), theme.dim)

    lines.push(padLine(`${glyph}${name}${desc}`, width, theme))
  }

  // Pad remaining
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  // ── Milestone layer rows ────────────────────────────────────────
  if (milestones.length > 0) {
    lines.push(padLine(color('✶ Milestones', theme.secondary, { bold: true }), width, theme))
    for (const m of milestones.slice(0, 5)) {
      lines.push(padLine(color(`  ${m}`.slice(0, width - 2), theme.dim), width, theme))
    }
  }
  if (recognition) {
    lines.push(padLine(color(recognition.slice(0, width - 2), theme.primary), width, theme))
  }

  lines.push(formatFooter('← → select  Enter activate  q quit', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── CommandPalette ────────────────────────────────────────────

export interface PaletteCommand {
  /** 命令标签 */
  label: string
  /** 快捷键提示 */
  hotkey?: string
  /** 描述 */
  description?: string
}

export interface PaletteData {
  commands: PaletteCommand[]
  selectedIndex: number
  searchText?: string
}

/**
 * 渲染 CommandPalette overlay（命令面板）。
 */
export function renderCommandPalette(data: PaletteData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme))

  const title = data.searchText
    ? `⌘ Commands — "${data.searchText}"`
    : '⌘ Commands'
  lines.push(formatTitleBar(title, width, theme))

  const maxItems = height - 5 // border + title + footer + border = 4; +1 safety
  const visible = data.commands.slice(0, maxItems)

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!
    const isSelected = i === data.selectedIndex
    const prefix = isSelected
      ? color('▶', theme.primary, { bold: true })
      : ' '

    const hotkey = cmd.hotkey
      ? color(` [${cmd.hotkey}]`, theme.muted)
      : ''

    const label = isSelected
      ? color(cmd.label, theme.primary, { bold: true })
      : color(cmd.label, theme.secondary)

    const desc = cmd.description
      ? ` — ${cmd.description}`
      : ''

    lines.push(padLine(`${prefix} ${label}${hotkey}${desc}`, width, theme))
  }

  for (let i = visible.length; i < maxItems; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter('↑↓ select  Enter run  q quit', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── Chronicle ─────────────────────────────────────────────────

export interface ChronicleEntry {
  /** 序号 */
  index: number
  /** 时间戳描述 */
  time: string
  /** 摘要 */
  summary: string
  /** 是否当前会话 */
  current: boolean
  /** 会话 id（Enter → resume 用；缺省则该条不可恢复） */
  id?: string
}

export interface ChronicleData {
  entries: ChronicleEntry[]
  title?: string
  /** 选中游标（↑↓ 导航高亮） */
  selectedIndex?: number
}

/**
 * 渲染 Chronicle overlay（会话编年史）。
 */
export function renderChronicle(data: ChronicleData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(data.title ?? '📜 会话编年史 Chronicle', width, theme))

  const idxWidth = 6
  const timeWidth = Math.min(14, Math.floor(width * 0.18))
  const summaryWidth = width - 2 - idxWidth - timeWidth - 5

  const maxEntries = height - 5
  const visible = data.entries.slice(0, maxEntries)
  const sel = data.selectedIndex ?? -1

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i]!
    const selected = i === sel
    // 选中游标 ▸；当前会话用 primary 高亮（与选中区分：选中靠游标，当前靠色）。
    const cursor = selected ? color('▸', theme.primary, { bold: true }) : ' '
    const idxColor = entry.current ? theme.primary : theme.dim
    const idx = color(`#${String(entry.index)}`.padEnd(idxWidth - 1), idxColor, entry.current ? { bold: true } : undefined)
    const time = color(entry.time.padEnd(timeWidth), entry.current ? theme.primary : theme.dim)
    const summaryText = entry.summary.slice(0, summaryWidth).padEnd(summaryWidth)
    const summary = selected || entry.current ? summaryText : color(summaryText, theme.dim)

    lines.push(padLine(`${cursor}${idx}${time}${summary}`, width, theme))
  }

  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter('↑↓ select  Enter → resume  q quit', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── Tasks ──────────────────────────────────────────────────────

export type TasksWorkerStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'escalated'

export interface TasksWorkerRow {
  /** 短标签，例如 "wo_team:T1" → "T1"。 */
  shortLabel: string
  profile: string
  status: TasksWorkerStatus
  /** 最新活动行或终态摘要。 */
  activity?: string
  elapsedMs: number
}

export interface TasksGroup {
  /** 派生这组 worker 的委派工具调用 id（不直接展示，仅用于分组/序号）。 */
  parentToolId: string
  total: number
  done: number
  failed: number
  running: number
  /** 该组当前在跑的 worker 行。 */
  workers: TasksWorkerRow[]
}

export interface TasksData {
  groups: TasksGroup[]
}

const TASK_STATUS_GLYPH: Record<TasksWorkerStatus, string> = {
  running: '◐',
  passed: '✓',
  failed: '✗',
  blocked: '⊘',
  escalated: '↑',
}

function tasksElapsed(ms: number): string {
  return ms > 1000 ? `${(ms / 1000).toFixed(0)}s` : `${ms}ms`
}

/** done/total 进度条（复用 worker 面板风格）。 */
function tasksProgressBar(done: number, total: number, width = 8): string {
  if (total <= 0) return '░'.repeat(width)
  const filled = Math.min(width, Math.round((done / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

export function renderTasks(data: TasksData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar('⚙ Running Agents', width, theme))

  const maxEntries = Math.max(1, height - 5)
  const totalActive = data.groups.reduce((n, g) => n + g.workers.length, 0)

  // 逐组渲染：组头（进度条 + done/total）后跟该组在跑 worker 行。多组时以
  // 序号区分（parentToolId 是不透明的 tool id，不直接展示）。
  const body: string[] = []
  const multiGroup = data.groups.length > 1
  data.groups.forEach((g, gi) => {
    const bar = color(tasksProgressBar(g.done, g.total), theme.muted)
    const counts = color(`${g.done}/${g.total} done`, theme.muted)
    const failedNote = g.failed > 0 ? color(`  ${g.failed} failed`, theme.warning) : ''
    const groupTitle = multiGroup ? `group ${gi + 1}` : 'fleet'
    body.push(` ${color('◆', theme.primary)} ${groupTitle}  ${bar} ${counts}${failedNote}`)
    for (const w of g.workers) {
      const glyph = TASK_STATUS_GLYPH[w.status] ?? '·'
      const glyphColored = w.status === 'running'
        ? color(glyph, theme.primary)
        : w.status === 'passed'
          ? color(glyph, theme.success)
          : color(glyph, theme.warning)
      const label = `${w.shortLabel}·${w.profile}`.slice(0, 22).padEnd(22)
      const activity = w.activity ? ` ${w.activity}` : ''
      const elapsed = color(`(${tasksElapsed(w.elapsedMs)})`, theme.muted)
      const detailMax = Math.max(0, width - 32 - stringWidth(elapsed))
      const detail = activity.slice(0, detailMax)
      body.push(`   ${glyphColored} ${label}${detail} ${elapsed}`)
    }
  })

  if (totalActive === 0) {
    body.push(color(' (no running workers)', theme.dim))
  }

  const visible = body.slice(0, maxEntries)
  for (const line of visible) {
    lines.push(padLine(line, width, theme))
  }
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  const summary = totalActive === 1 ? '1 worker running' : `${totalActive} workers running`
  lines.push(formatFooter(`${summary}  ·  q quit`, width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}
