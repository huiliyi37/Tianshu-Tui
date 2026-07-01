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
import { THEMES, type RivetTheme, type ThemeName } from '../theme.js'
import { formatElapsed } from '../tool-elapsed.js'
import type { TranscriptMessage } from '../scrollback-transcript.js'
import type { ConnectView } from '../connect-flow.js'


function renderTabBar(activeTab: 'domain' | 'model' | 'theme', width: number, theme: RivetTheme): string {
  const tabDomain = activeTab === 'domain' ? color(' 🎛  Domain ', theme.primary, { bold: true }) : color('    Domain ', theme.dim)
  const tabModel = activeTab === 'model' ? color(' 🤖 Model ', theme.primary, { bold: true }) : color('    Model ', theme.dim)
  const tabTheme = activeTab === 'theme' ? color(' 🎨 Theme ', theme.primary, { bold: true }) : color('    Theme ', theme.dim)
  
  const separator = color(' │ ', theme.dim)
  const tabs = `${tabDomain}${separator}${tabModel}${separator}${tabTheme}`
  const tabsPlain = ' 🎛  Domain  │     Model  │     Theme'
  const remaining = Math.max(0, width - 2 - stringWidth(tabsPlain))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│', theme.dim) + ' '.repeat(left) + tabs + ' '.repeat(right) + color('│', theme.dim)
}

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
  const maxHintWidth = Math.max(0, width - 4) // 2 borders + 1 space each side
  let visibleHint = hint
  if (stringWidth(visibleHint) > maxHintWidth) {
    // Preserve the right-hand side (close hints are usually at the tail).
    let suffix = ''
    let suffixWidth = 0
    const chars = Array.from(hint)
    for (let i = chars.length - 1; i >= 0; i--) {
      const cw = stringWidth(chars[i]!)
      if (suffixWidth + cw + 1 > maxHintWidth) break // +1 for leading ellipsis
      suffix = chars[i]! + suffix
      suffixWidth += cw
    }
    visibleHint = '…' + suffix
  }
  const padded = ` ${visibleHint} `
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
  /** 当前模式 */
  mode?: 'page' | 'search' | 'message'
  /** 搜索 query */
  searchQuery?: string
  /** 搜索总匹配数 */
  searchMatches?: number
  /** 当前匹配序号（1-based） */
  searchCurrent?: number
  /** 消息列表（用于搜索/消息视图） */
  messages?: TranscriptMessage[]
  /** 当前选中的消息索引（message 模式） */
  selectedMessageIndex?: number
}

const ANSI_RE = /\x1B\[[0-9;]*[a-zA-Z]/g
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

function lineMatchesQuery(line: string, query: string): boolean {
  return stripAnsi(line).toLowerCase().includes(query.toLowerCase())
}

function highlightMatch(line: string, query: string, width: number, theme: RivetTheme): string {
  if (!query) return line
  const plain = stripAnsi(line)
  const q = query.toLowerCase()
  const idx = plain.toLowerCase().indexOf(q)
  if (idx === -1) return line
  const before = plain.slice(0, idx)
  const match = plain.slice(idx, idx + q.length)
  const after = plain.slice(idx + q.length)
  const highlighted = `${before}${color(match, theme.primary, { bold: true })}${after}`
  // Re-pad to width; highlighted line may have different display width due to ANSI,
  // but padLine uses stringWidth which strips ANSI, so it's safe.
  const padding = Math.max(0, width - 2 - stringWidth(highlighted))
  return color('│', theme.dim) + highlighted + ' '.repeat(padding) + color('│', theme.dim)
}

function pageForMessage(messages: readonly TranscriptMessage[], messageIndex: number, pageSize: number): number {
  if (messageIndex < 0 || messageIndex >= messages.length || pageSize <= 0) return 0
  let rows = 0
  for (let i = 0; i < messageIndex; i++) {
    rows += messages[i]!.lines.length
  }
  return Math.floor(rows / pageSize)
}

/**
 * 渲染 Pager overlay（分页文本查看器）。
 *
 * 支持三种模式：
 * - page：传统分页
 * - search：高亮匹配行，标题显示匹配计数
 * - message：聚焦单条消息
 */
export function renderPager(data: PagerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const contentLines = data.content.split('\n')
  const pageSize = height - 4 // 1 border top + 1 title + 1 footer + 1 border bottom = 4
  const totalPages = Math.max(1, Math.ceil(contentLines.length / pageSize))
  const mode = data.mode ?? 'page'
  const messages = data.messages ?? []

  let effectivePage = Math.min(data.page, totalPages - 1)
  let title: string
  let footer = '↑↓/j/k scroll  PgUp/PgDn  /search  m message  q/Esc close'

  if (mode === 'search') {
    const current = data.searchCurrent ?? 0
    const total = data.searchMatches ?? 0
    const query = data.searchQuery ?? ''
    title = data.title
      ? `${data.title} — Search "${query}" (${current}/${total})`
      : `Search "${query}" (${current}/${total})`
    footer = 'n/N next/prev  Esc clear search  q close'
    if (messages.length > 0 && current > 0) {
      const msgIdx = current - 1 < messages.length ? current - 1 : 0
      effectivePage = pageForMessage(messages, msgIdx, pageSize)
      effectivePage = Math.min(effectivePage, totalPages - 1)
    }
  } else if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    title = data.title
      ? `${data.title} — Message ${idx + 1}/${messages.length}`
      : `Message ${idx + 1}/${messages.length}`
    footer = '↑↓/j/k prev/next message  Esc back  q close'
    effectivePage = pageForMessage(messages, idx, pageSize)
    effectivePage = Math.min(effectivePage, totalPages - 1)
  } else {
    title = data.title ? `${data.title} (${effectivePage + 1}/${totalPages})` : `Page ${effectivePage + 1}/${totalPages}`
  }

  // Top border + title
  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(title, width, theme))

  // Content
  const start = effectivePage * pageSize
  const pageLines = contentLines.slice(start, start + pageSize)

  if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    const msg = messages[idx]!
    const header = msg.isTruncated
      ? color(`〔message ${idx + 1}/${messages.length} — truncated in scrollback〕`, theme.warning)
      : color(`〔message ${idx + 1}/${messages.length}〕`, theme.dim)
    lines.push(padLine(header, width, theme))
    for (const line of msg.lines.slice(0, pageSize - 1)) {
      lines.push(padLine(line, width, theme))
    }
    for (let i = msg.lines.length + 1; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  } else if (mode === 'search') {
    for (let i = 0; i < pageLines.length; i++) {
      const line = pageLines[i]!
      if (data.searchQuery && lineMatchesQuery(line, data.searchQuery)) {
        lines.push(highlightMatch(line, data.searchQuery, width, theme))
      } else {
        lines.push(padLine(line, width, theme))
      }
    }
    for (let i = pageLines.length; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  } else {
    for (const line of pageLines) {
      lines.push(padLine(line, width, theme))
    }
    for (let i = pageLines.length; i < pageSize; i++) {
      lines.push(padLine('', width, theme))
    }
  }

  // Footer + bottom border
  lines.push(formatFooter(footer, width, theme))
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
  /** UI 微气质 — 主题语义色键 (primary/secondary/success/warning/error/dim) */
  accent?: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
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
  const glyphWidth = 5
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
    const accentKey = (entry.accent as keyof RivetTheme) ?? 'primary'
    const accentColor = (theme as any)[accentKey] ?? theme.primary
    const glyph = entry.active
      ? color(` ${entry.glyph} `.padEnd(glyphWidth), accentColor, { bold: true })
      : color(` ${entry.glyph} `.padEnd(glyphWidth), theme.dim)
    const name = entry.active
      ? color(entry.name.padEnd(nameWidth), accentColor)
      : color(entry.name.padEnd(nameWidth), theme.dim)
    const desc = entry.active
      ? entry.description.slice(0, descWidth).padEnd(descWidth)
      : color(entry.description.slice(0, descWidth).padEnd(descWidth), theme.muted)

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

  lines.push(formatFooter('↑↓/j/k select  Enter activate  q/Esc close', width, theme))
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

  lines.push(formatFooter('Esc cancel  ↑↓ select  Enter run', width, theme))
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
    const summary = selected || entry.current ? summaryText : color(summaryText, theme.muted)

    lines.push(padLine(`${cursor}${idx}${time}${summary}`, width, theme))
  }

  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter('↑↓ select  Enter → resume  Esc close', width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── Tasks ──────────────────────────────────────────────────────

export type TasksWorkerStatus = 'running' | 'passed' | 'failed' | 'blocked' | 'escalated'

export interface TasksWorkerRow {
  /** 稳定的 per-worker id（work order id），用于进入 detail pager。 */
  workerId: string
  /** 短标签，例如 "wo_team:T1" → "T1"。 */
  shortLabel: string
  profile: string
  status: TasksWorkerStatus
  /** 最新活动行或终态摘要。 */
  activity?: string
  elapsedMs: number
}

export type TasksFilter = 'running' | 'completed' | 'all'

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
  /** 当前 filter 模式。 */
  filter: TasksFilter
  /** 已终态 worker 总数（用于 footer 提示）。 */
  completedCount: number
}

const TASK_STATUS_GLYPH: Record<TasksWorkerStatus, string> = {
  running: '◐',
  passed: '✓',
  failed: '✗',
  blocked: '⊘',
  escalated: '↑',
}

/** done/total 进度条（复用 worker 面板风格）。 */
function tasksProgressBar(done: number, total: number, width = 8): string {
  if (total <= 0) return '░'.repeat(width)
  const filled = Math.min(width, Math.round((done / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

// ── Model Picker ───────────────────────────────────────────────

export interface ModelPickerEntry {
  id: string
  alias: string
  current: boolean
  contextWindow?: number
}

export interface ModelPickerData {
  entries: ModelPickerEntry[]
  selectedIndex: number
}

// ── Theme Picker ───────────────────────────────────────────────

export interface ThemePickerEntry {
  name: string
  current: boolean
  description: string
}

export interface ThemePickerData {
  entries: ThemePickerEntry[]
  selectedIndex: number
}

// ── Domain Picker ──────────────────────────────────────────────

export interface DomainPickerEntry {
  /** 选择键：'auto' | 'off' | domain id */
  key: string
  /** 展示名（中文星域名或 Auto/Off 标签） */
  name: string
  /** 座右铭（可空） */
  motto: string
  /** 次要元信息（dim）：decisionStyle · keywords */
  meta: string
  /** 选中项的一段式 essence 预览（不转储整段 volatileBlock） */
  essence: string
  /** 是否为当前生效项 */
  current: boolean
  uiPersona?: {
    separator: 'thin' | 'thick' | 'dots'
    accent: 'primary' | 'secondary' | 'success' | 'warning' | 'error' | 'dim'
    glyph: string
  }
}

export interface DomainPickerData {
  entries: DomainPickerEntry[]
  selectedIndex: number
}

/** 按显示宽度（CJK 感知）软换行为多行，最多 maxLines 行。 */
function wrapToWidth(text: string, width: number, maxLines: number): string[] {
  if (width <= 0 || maxLines <= 0) return []
  const out: string[] = []
  let line = ''
  let w = 0
  for (const ch of text.replace(/\s+/g, ' ').trim()) {
    const cw = stringWidth(ch)
    if (w + cw > width) {
      out.push(line)
      if (out.length >= maxLines) {
        // 末行加省略号标记溢出
        const last = out[maxLines - 1]!
        out[maxLines - 1] = last.length > 1 ? last.slice(0, -1) + '…' : '…'
        return out.slice(0, maxLines)
      }
      line = ''
      w = 0
    }
    line += ch
    w += cw
  }
  if (line) out.push(line)
  return out.slice(0, maxLines)
}

/**
 * 渲染 Domain Picker overlay（CC 风星域选择器）。
 *
 * 列表（cursor + current 标记 + name + dim meta）→ 分隔线 → 选中项 essence 预览。
 * 应用后只写单行确认，完整方法论照常由引擎注入（UI 不转储 volatileBlock）。
 */
export function renderDomainPicker(data: DomainPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  lines.push(renderTabBar('domain', width, theme))

  const innerWidth = width - 4 // padLine 占 2，左右各留 1 空隙
  const contentRows = Math.max(3, height - 4) // border + title + footer + bottom
  const previewRows = Math.min(4, Math.max(2, contentRows - data.entries.length - 1))
  const listRows = Math.max(1, contentRows - previewRows - 1)

  const sel = data.selectedIndex
  const current = data.entries[sel]
  const currentAccentKey = current?.uiPersona?.accent ?? 'primary'
  const currentAccent = (theme as any)[currentAccentKey] ?? theme.primary

  const visible = data.entries.slice(0, listRows)
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!
    const selected = i === sel
    const eAccentKey = e.uiPersona?.accent ?? 'primary'
    const eAccent = (theme as any)[eAccentKey] ?? theme.primary
    const eGlyph = e.uiPersona?.glyph ?? '●'

    const cursor = selected ? color('▶', currentAccent, { bold: true }) : ' '
    const mark = e.current ? color(eGlyph, eAccent, { bold: true }) : selected ? color(eGlyph, currentAccent) : color(eGlyph, theme.dim)
    const name = selected ? color(e.name, currentAccent, { bold: true }) : color(e.name, theme.secondary)
    const motto = e.motto ? `  ${e.motto}` : ''
    const head = `${cursor} ${mark} ${name}${color(motto, theme.dim)}`
    
    // meta 接在 motto 之后（dim），按内宽截断（用 plain 长度估算，避免 SGR 计入）
    const plainHead = `  ${eGlyph} ${e.name}${motto}`
    const metaRoom = Math.max(0, innerWidth - stringWidth(plainHead) - 2)
    const metaText = e.meta && metaRoom > 6 ? `  ${e.meta}`.slice(0, metaRoom) : ''
    lines.push(padLine(`${head}${color(metaText, theme.dim)}`, width, theme))
  }
  for (let i = visible.length; i < listRows; i++) {
    lines.push(padLine('', width, theme))
  }

  // 分隔线自适应强调色与样式
  const sepChar = current?.uiPersona?.separator === 'dots' 
    ? '·' 
    : current?.uiPersona?.separator === 'thick' 
      ? '━' 
      : '─'
  lines.push(padLine(` ${color(sepChar.repeat(Math.max(0, innerWidth - 1)), currentAccent)}`, width, theme))

  // 选中项 essence 预览
  const previewLines: string[] = []
  if (current) {
    const glyph = current.uiPersona?.glyph ?? '●'
    previewLines.push(color(`  ${glyph}  ${current.motto}`, currentAccent, { bold: true }))
    
    const plainEssence = current.essence || ''
    const wrappedEssence = wrapToWidth(plainEssence, innerWidth - 1, previewRows - 1)
    for (const d of wrappedEssence) {
      if (previewLines.length < previewRows) {
        previewLines.push(` ${color(d, theme.muted)}`)
      }
    }
  }

  for (let i = 0; i < previewRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  lines.push(formatFooter('←/→ tab  ↑↓ select  Enter apply  Esc cancel', width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}

export function renderTasks(
  data: TasksData,
  width: number,
  height: number,
  theme: RivetTheme,
  selectedIndex = -1,
): string[] {
  const lines: string[] = []
  const title = data.filter === 'completed' ? 'Completed Agents'
    : data.filter === 'all' ? 'All Agents'
      : 'Running Agents'
  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(title, width, theme))

  const maxEntries = Math.max(1, height - 5)

  // 逐组渲染：组头（进度条 + done/total）后跟 worker 行。多组时以
  // 序号区分（parentToolId 是不透明的 tool id，不直接展示）。
  const body: string[] = []
  const selectable: { workerId: string; bodyIndex: number }[] = []
  const multiGroup = data.groups.length > 1
  data.groups.forEach((g, gi) => {
    const bar = color(tasksProgressBar(g.done, g.total), theme.muted)
    const counts = color(`${g.done}/${g.total} done`, theme.muted)
    const failedNote = g.failed > 0 ? color(`  ${g.failed} failed`, theme.warning) : ''
    const groupTitle = multiGroup ? `group ${gi + 1}` : 'fleet'
    body.push(` ${color('◆', theme.primary)} ${groupTitle}  ${bar} ${counts}${failedNote}`)
    for (const w of g.workers) {
      selectable.push({ workerId: w.workerId, bodyIndex: body.length })
      const glyph = TASK_STATUS_GLYPH[w.status] ?? '·'
      const glyphColored = w.status === 'running'
        ? color(glyph, theme.primary)
        : w.status === 'passed'
          ? color(glyph, theme.success)
          : color(glyph, theme.warning)
      const label = `${w.shortLabel}·${w.profile}`.slice(0, 22).padEnd(22)
      const activity = w.activity ? ` ${w.activity}` : ''
      const elapsed = color(`(${formatElapsed(w.elapsedMs)})`, theme.muted)
      const detailMax = Math.max(0, width - 32 - stringWidth(elapsed))
      const detail = activity.slice(0, detailMax)
      body.push(`   ${glyphColored} ${label}${detail} ${elapsed}`)
    }
  })

  if (selectable.length === 0) {
    const emptyText = data.filter === 'completed' ? ' (no completed workers)'
      : data.filter === 'all' ? ' (no workers)'
        : ' (no running workers)'
    body.push(color(emptyText, theme.dim))
  }

  const selectedBodyIndex = selectedIndex >= 0 && selectedIndex < selectable.length
    ? selectable[selectedIndex]!.bodyIndex
    : -1

  const visible = body.slice(0, maxEntries)
  for (let i = 0; i < visible.length; i++) {
    let line = visible[i]!
    if (i === selectedBodyIndex) {
      // 把前导三个空格替换为光标 + 两个空格，保持宽度一致
      line = `${color('▶', theme.primary, { bold: true })}  ${line.slice(3)}`
    }
    lines.push(padLine(line, width, theme))
  }
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  const runningCount = data.groups.reduce((n, g) => n + g.workers.filter(w => w.status === 'running').length, 0)
  const visibleCount = data.groups.reduce((n, g) => n + g.workers.length, 0)
  const summaryParts: string[] = []
  if (data.filter === 'running' || data.filter === 'all') {
    summaryParts.push(`${runningCount} running`)
  }
  if (data.filter === 'completed' || data.filter === 'all') {
    summaryParts.push(`${data.completedCount} completed`)
  }
  if (summaryParts.length === 0) summaryParts.push(`${visibleCount} workers`)
  const summary = summaryParts.join(' · ')
  lines.push(formatFooter(`${summary}  ·  ↑↓ select  Enter detail  Tab filter  q/Esc close`, width, theme))
  lines.push(formatBottomBorder(width, theme))

  return lines
}

// ── Model Picker ───────────────────────────────────────────────

export function renderModelPicker(data: ModelPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  lines.push(renderTabBar('model', width, theme))

  const innerWidth = width - 4
  const contentRows = Math.max(3, height - 4)
  const previewRows = Math.min(4, Math.max(2, contentRows - data.entries.length - 1))
  const listRows = Math.max(1, contentRows - previewRows - 1)

  const sel = data.selectedIndex
  const visible = data.entries.slice(0, listRows)
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!
    const selected = i === sel
    const cursor = selected ? color('▶', theme.primary, { bold: true }) : ' '
    const mark = e.current ? color('●', theme.primary) : ' '
    const aliasColor = selected ? color(e.alias, theme.primary, { bold: true }) : color(e.alias, theme.secondary)
    const idText = ` [${e.id}]`
    const tokensText = e.contextWindow ? `  ${(e.contextWindow / 1000).toFixed(0)}k ctx` : ''
    const head = `${cursor} ${mark} ${aliasColor}${color(idText, theme.dim)}`
    
    const plainHead = `  ${e.current ? '●' : ' '} ${e.alias}${idText}`
    const metaRoom = Math.max(0, innerWidth - stringWidth(plainHead) - 2)
    const metaText = tokensText && metaRoom > 6 ? tokensText.slice(0, metaRoom) : ''
    lines.push(padLine(`${head}${color(metaText, theme.dim)}`, width, theme))
  }
  for (let i = visible.length; i < listRows; i++) {
    lines.push(padLine('', width, theme))
  }

  // Divider
  lines.push(padLine(` ${color('─'.repeat(Math.max(0, innerWidth - 1)), theme.dim)}`, width, theme))
  const current = data.entries[sel]
  const previewLines: string[] = []
  if (current) {
    const modelDesc = current.id.includes('pro') || current.id.includes('reasoning') || current.id.includes('o1') || current.id.includes('5.5')
      ? '性能旗舰：支持长考与高级推理，完美攻克超复杂重构与深层 Debug 任务。'
      : '极速先锋：响应灵敏、前缀缓存友好度极高，适合日常代码编写与文件级小修补。'
    const ctxText = current.contextWindow 
      ? `上下文配额: ${current.contextWindow.toLocaleString()} tokens` 
      : '上下文配额: 128k tokens'
    const features = `标识: ${current.id}  ·  别名: ${current.alias}`
    const wrappedDesc = wrapToWidth(modelDesc, innerWidth - 1, previewRows - 2)
    previewLines.push(color(`  ${ctxText}`, theme.primary))
    previewLines.push(color(`  ${features}`, theme.dim))
    for (const d of wrappedDesc) {
      if (previewLines.length < previewRows) {
        previewLines.push(` ${color(d, theme.muted)}`)
      }
    }
  }
  
  for (let i = 0; i < previewRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  lines.push(formatFooter('←/→ tab  ↑↓ select  Enter apply  Esc cancel', width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}

// ── Theme Picker ───────────────────────────────────────────────

export function renderThemePicker(data: ThemePickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  lines.push(renderTabBar('theme', width, theme))

  const innerWidth = width - 4
  const contentRows = Math.max(3, height - 4)
  const previewRows = Math.min(6, Math.max(4, contentRows - data.entries.length - 1))
  const listRows = Math.max(1, contentRows - previewRows - 1)

  const sel = data.selectedIndex
  const visible = data.entries.slice(0, listRows)
  for (let i = 0; i < visible.length; i++) {
    const e = visible[i]!
    const selected = i === sel
    const cursor = selected ? color('▶', theme.primary, { bold: true }) : ' '
    const mark = e.current ? color('●', theme.primary) : ' '
    const nameColor = selected ? color(e.name, theme.primary, { bold: true }) : color(e.name, theme.secondary)
    lines.push(padLine(`${cursor} ${mark} ${nameColor}`, width, theme))
  }
  for (let i = visible.length; i < listRows; i++) {
    lines.push(padLine('', width, theme))
  }

  // Divider
  lines.push(padLine(` ${color('─'.repeat(Math.max(0, innerWidth - 1)), theme.dim)}`, width, theme))
  const current = data.entries[sel]
  const previewLines: string[] = []
  if (current) {
    // 1. Description
    const wrappedDesc = wrapToWidth(current.description, innerWidth - 1, 2)
    for (const d of wrappedDesc) {
      previewLines.push(` ${color(d, theme.muted)}`)
    }
    
    // 2. Swatch Preview!
    const targetThemeInfo = THEMES[current.name as ThemeName]
    if (targetThemeInfo) {
      const tc = targetThemeInfo.truecolor
      const primarySwatch = color('● Accent', tc.primary)
      const secondarySwatch = color('● Secondary', tc.secondary)
      const successSwatch = color('✓ Success', tc.success)
      const errorSwatch = color('✗ Error', tc.error)
      const swatchLine = `  ${primarySwatch}  ${secondarySwatch}  ${successSwatch}  ${errorSwatch}`
      previewLines.push(swatchLine)
    }
  }
  
  for (let i = 0; i < previewRows; i++) {
    lines.push(padLine(previewLines[i] ?? '', width, theme))
  }

  lines.push(formatFooter('←/→ tab  ↑↓ select  Enter apply  Esc cancel', width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}

// ── Choice Panel (通用选项选择弹窗) ──────────────────────────────
// A question + N choices (each with optional description + recommended flag).
// Used when the agent needs the user to pick one of several strategies,
// confirm a risky action, or select a star domain — the TUI equivalent of
// the desktop "ask" overlay.

export interface ChoiceEntry {
  id: string
  label: string
  description?: string
  /** Marked with ★ to guide the user toward the agent's suggestion. */
  recommended?: boolean
}

export interface ChoicePanelData {
  /** Question / prompt shown as the title bar. */
  title: string
  choices: ChoiceEntry[]
  selectedIndex: number
}

export function renderChoicePanel(data: ChoicePanelData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  lines.push(formatTitleBar(data.title, width, theme))
  lines.push(padLine(color('─'.repeat(Math.max(0, width - 4)), theme.dim), width, theme))

  const innerWidth = width - 6 // padLine border(2) + left indent(2) + right gap(2)
  const contentRows = Math.max(1, height - 5) // border + title + separator + footer + bottom

  if (data.choices.length === 0) {
    lines.push(padLine(color('  （无可用选项）', theme.dim), width, theme))
    lines.push(formatFooter('Esc close', width, theme))
    lines.push(formatBottomBorder(width, theme))
    return lines
  }

  // Each choice takes 1-2 lines (label + optional description). Calculate
  // how many fit, with wrapping for long descriptions.
  let rowsUsed = 0
  for (let i = 0; i < data.choices.length; i++) {
    if (rowsUsed >= contentRows) break
    const c = data.choices[i]!
    const selected = i === data.selectedIndex
    const accent = selected ? theme.primary : theme.dim

    // Label line: cursor + recommended star + label
    const cursor = selected ? color('▶', theme.primary, { bold: true }) : ' '
    const star = c.recommended ? color('★', theme.warning ?? theme.primary, { bold: true }) : ' '
    const labelColor = selected ? theme.primary : theme.secondary
    const labelText = selected ? color(c.label, labelColor, { bold: true }) : color(c.label, labelColor)
    lines.push(padLine(` ${cursor} ${star} ${labelText}`, width, theme))
    rowsUsed++

    // Description line(s)
    if (c.description && rowsUsed < contentRows) {
      const descWrapped = wrapToWidth(c.description, innerWidth, 2)
      for (const d of descWrapped) {
        if (rowsUsed >= contentRows) break
        lines.push(padLine(`     ${color(d, theme.muted)}`, width, theme))
        rowsUsed++
      }
    }
  }

  // Pad remaining rows
  while (rowsUsed < contentRows) {
    lines.push(padLine('', width, theme))
    rowsUsed++
  }

  lines.push(formatFooter('↑↓ select  Enter confirm  Esc cancel', width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}

// ── Connect Wizard (/connect 服务商配置向导) ──────────────────────
// Single stateful overlay driven by ConnectFlow: renders either a choice list
// (provider pick) or a masked/plain text input (URL / model / key), plus a live
// validation error line. Mirrors the polished scream-code connect experience.

export interface ConnectOverlayData {
  view: ConnectView
  /** Live input buffer for input-kind steps. */
  input: string
  /** Validation error for the current step (shown in red). */
  error?: string
  /** Selected option index for choice-kind steps. */
  selectedIndex: number
}

function maskSecret(value: string): string {
  return '•'.repeat([...value].length)
}

export function renderConnect(data: ConnectOverlayData, width: number, height: number, theme: RivetTheme): string[] {
  const { view } = data
  const lines: string[] = []
  lines.push(formatBorder(width, theme))
  const titleBar = view.stepLabel ? `${view.title}   ${view.stepLabel}` : view.title
  lines.push(formatTitleBar(titleBar, width, theme))
  lines.push(padLine(color('─'.repeat(Math.max(0, width - 4)), theme.dim), width, theme))

  const innerWidth = width - 6
  const contentRows = Math.max(1, height - 5)
  let rowsUsed = 0
  const push = (s: string): void => { lines.push(padLine(s, width, theme)); rowsUsed++ }

  if (view.subtitle && rowsUsed < contentRows) {
    for (const d of wrapToWidth(view.subtitle, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.muted)}`)
    }
    if (rowsUsed < contentRows) push('')
  }

  if (view.kind === 'choice') {
    const options = view.options ?? []
    for (let i = 0; i < options.length; i++) {
      if (rowsUsed >= contentRows) break
      const opt = options[i]!
      const selected = i === data.selectedIndex
      const cursor = selected ? color('▶', theme.primary, { bold: true }) : ' '
      const star = opt.recommended ? color('★', theme.warning ?? theme.primary, { bold: true }) : ' '
      const labelColor = selected ? theme.primary : theme.secondary
      const label = selected ? color(opt.label, labelColor, { bold: true }) : color(opt.label, labelColor)
      push(` ${cursor} ${star} ${label}`)
      if (opt.description && rowsUsed < contentRows) {
        for (const d of wrapToWidth(opt.description, innerWidth, 2)) {
          if (rowsUsed >= contentRows) break
          push(`     ${color(d, theme.muted)}`)
        }
      }
    }
  } else {
    const shown = view.masked ? maskSecret(data.input) : data.input
    const cursor = color('▏', theme.primary, { bold: true })
    const body = shown.length > 0 ? color(shown, theme.secondary) : color(view.placeholder ?? '', theme.dim)
    push(` ${color('>', theme.primary, { bold: true })} ${body}${cursor}`)
  }

  if (data.error && rowsUsed < contentRows) {
    push('')
    for (const d of wrapToWidth(data.error, innerWidth, 1)) {
      if (rowsUsed >= contentRows) break
      push(` ${color(d, theme.error ?? theme.primary)}`)
    }
  }

  while (rowsUsed < contentRows) push('')

  const footer = view.kind === 'choice' ? '↑↓ 选择  Enter 确认  Esc 取消' : 'Enter 提交  Esc 取消'
  lines.push(formatFooter(footer, width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}

// ── Fleet Detail (子代理详情弹窗) ───────────────────────────────
// Shows expanded details for a single delegation worker: profile, status,
// current activity, elapsed, authority. Triggered by pressing Enter on a
// worker row in the fleet panel.

import type { FleetWorkerView } from '../fleet-registry.js'

export function renderFleetDetail(worker: FleetWorkerView, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme))

  // Title: status glyph + worker label
  const statusGlyph = worker.terminal
    ? (worker.status === 'passed' ? '✓' : worker.status === 'failed' ? '✗' : '⚠')
    : '◐'
  const statusColor = worker.terminal
    ? (worker.status === 'passed' ? theme.success : worker.status === 'failed' ? theme.error : theme.warning)
    : theme.primary
  lines.push(formatTitleBar(`${color(statusGlyph, statusColor)} ${worker.shortLabel}`, width, theme))
  lines.push(padLine(color('─'.repeat(Math.max(0, width - 4)), theme.dim), width, theme))

  // Detail rows
  const rows: [string, string][] = []
  rows.push(['Profile', worker.profile])
  rows.push(['Status', worker.status])
  if (worker.authority) rows.push(['Authority', worker.authority])
  rows.push(['Parent', worker.parentToolId])
  rows.push(['Elapsed', worker.elapsedMs > 1000 ? `${(worker.elapsedMs / 1000).toFixed(1)}s` : `${worker.elapsedMs}ms`])

  for (const [label, value] of rows) {
    lines.push(padLine(` ${color(label, theme.muted)}: ${color(value, theme.secondary)}`, width, theme))
  }

  // Activity log (ring buffer — newest last; fallback to single activity line)
  const activityLog = worker.activityLog ?? (worker.activity ? [worker.activity] : [])
  if (activityLog.length > 0) {
    lines.push(padLine('', width, theme))
    lines.push(padLine(` ${color('Activity Log:', theme.muted)}`, width, theme))
    for (const entry of activityLog) {
      lines.push(padLine(`   ${color('⎿', theme.dim)} ${color(entry, theme.secondary)}`, width, theme))
    }
  }

  // Pad to fill height
  const remaining = Math.max(0, height - lines.length - 3)
  for (let i = 0; i < remaining; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter('Esc close', width, theme))
  lines.push(formatBottomBorder(width, theme))
  return lines
}
