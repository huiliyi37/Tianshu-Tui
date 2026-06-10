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
  const remaining = width - 2 - padded.length
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│' + ' '.repeat(left) + padded + ' '.repeat(right) + '│', theme.dim)
}

function formatFooter(hint: string, width: number, theme: RivetTheme): string {
  const padded = ` ${hint} `
  const remaining = width - 2 - padded.length
  return color('│' + padded + ' '.repeat(Math.max(0, remaining)) + '│', theme.dim)
}

function padLine(text: string, width: number, theme: RivetTheme): string {
  const visible = text.replace(/\x1B\[[0-9;]*[a-zA-Z]/g, '')
  const padding = Math.max(0, width - 2 - visible.length)
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
}

/**
 * 渲染 Starmap overlay（星域/星君总览）。
 */
export function renderStarmap(data: StarmapData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []

  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(data.title ?? '❂ 星域总览 Starmap', width, theme))

  // Column widths
  const glyphWidth = 4
  const nameWidth = Math.min(20, Math.floor(width * 0.25))
  const descWidth = width - 2 - glyphWidth - nameWidth - 8 // 8 for padding/spacing

  // List entries
  const maxEntries = height - 6 // top border + title + header + footer + bottom border = 5; +1 safety
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
}

export interface ChronicleData {
  entries: ChronicleEntry[]
  title?: string
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

  for (const entry of visible) {
    const idx = entry.current
      ? color(` #${String(entry.index)}`.padEnd(idxWidth), theme.primary, { bold: true })
      : color(` #${String(entry.index)}`.padEnd(idxWidth), theme.dim)
    const time = entry.current
      ? color(entry.time.padEnd(timeWidth), theme.primary)
      : color(entry.time.padEnd(timeWidth), theme.dim)
    const summary = entry.current
      ? entry.summary.slice(0, summaryWidth).padEnd(summaryWidth)
      : color(entry.summary.slice(0, summaryWidth).padEnd(summaryWidth), theme.dim)

    lines.push(padLine(`${idx}${time}${summary}`, width, theme))
  }

  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter('↑↓ scroll  Enter view  q quit', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}
