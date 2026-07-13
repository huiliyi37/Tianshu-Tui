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
import { truncateToDisplayWidth } from '../width.js'
import { color } from '../engine/ansi.js'
import { resolveThemeEntry, type RivetTheme } from '../theme.js'
import { formatElapsed } from '../tool-elapsed.js'
import { formatTokenCount } from './spinner-status.js'
import type { TranscriptMessage } from '../scrollback-transcript.js'
import type { ConnectView } from '../connect-flow.js'
import {
  frameTop as formatBorder,
  frameBottom as formatBottomBorder,
  frameTitleCenter as formatTitleBar,
  frameTitleLeft as formatTitleLeft,
  frameFooter as formatFooter,
  frameLine as padLine,
  frameDivider,
  CURSOR,
  CURRENT_MARK,
  keyHints,
  type BorderStyle,
} from './overlay-frame.js'


/** 紧凑快捷键提示（逗号分隔，类似 fzf 风格）。 */
function compactHints(pairs: [key: string, action: string][]): string {
  return pairs.map(([k, a]) => `${k}:${a}`).join(', ')
}

function renderTabBar(activeTab: 'domain' | 'model' | 'theme', width: number, theme: RivetTheme): string {
  const tabDomain = activeTab === 'domain' ? color('Domain', theme.primary, { bold: true }) : color(' Domain ', theme.dim)
  const tabModel = activeTab === 'model' ? color('Model', theme.primary, { bold: true }) : color(' Model ', theme.dim)
  const tabTheme = activeTab === 'theme' ? color('Theme', theme.primary, { bold: true }) : color(' Theme ', theme.dim)

  const separator = color('│', theme.dim)
  const tabs = `${tabDomain}${separator}${tabModel}${separator}${tabTheme}`
  const tabsPlain = 'Domain  │  Model  │  Theme'
  const remaining = Math.max(0, width - 2 - stringWidth(tabsPlain))
  const left = Math.floor(remaining / 2)
  const right = remaining - left
  return color('│', theme.dim) + ' '.repeat(left) + tabs + ' '.repeat(right) + color('│', theme.dim)
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
  /** verbose 层：内容源为完整工具输出的详细转录（`v` 切换） */
  verbose?: boolean
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
  const verboseHint: [string, string] = data.verbose ? ['v', '简略'] : ['v', '详细']
  let footer = compactHints([['↑↓/j/k', '滚动'], ['PgUp/PgDn', '翻页'], ['/', '搜索'], verboseHint, ['q', '关闭']])

  if (mode === 'search') {
    const current = data.searchCurrent ?? 0
    const total = data.searchMatches ?? 0
    const query = data.searchQuery ?? ''
    title = data.title
      ? `${data.title} — 搜索 "${query}" (${current}/${total})`
      : `搜索 "${query}" (${current}/${total})`
    footer = compactHints([['n/N', '匹配'], ['Esc', '清除'], ['q', '关闭']])
    if (messages.length > 0 && current > 0) {
      const msgIdx = current - 1 < messages.length ? current - 1 : 0
      effectivePage = pageForMessage(messages, msgIdx, pageSize)
      effectivePage = Math.min(effectivePage, totalPages - 1)
    }
  } else if (mode === 'message' && messages.length > 0) {
    const idx = Math.min(Math.max(0, data.selectedMessageIndex ?? 0), messages.length - 1)
    title = data.title
      ? `${data.title} — 消息 ${idx + 1}/${messages.length}`
      : `消息 ${idx + 1}/${messages.length}`
    footer = compactHints([['↑↓/j/k', '切换'], ['Esc', '返回'], ['q', '关闭']])
    effectivePage = pageForMessage(messages, idx, pageSize)
    effectivePage = Math.min(effectivePage, totalPages - 1)
  } else {
    const verboseTag = data.verbose ? ' [verbose]' : ''
    title = data.title ? `${data.title}${verboseTag} (${effectivePage + 1}/${totalPages})` : `查看${verboseTag} (${effectivePage + 1}/${totalPages})`
  }

  // Top border + title
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(title, width, theme))

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
  lines.push(formatFooter(footer, width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

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

  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title ?? '星域总览', width, theme))

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

  lines.push(formatFooter(compactHints([['↑↓/j/k', '选择'], ['Enter', '激活'], ['q/Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

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

  lines.push(formatBorder(width, theme, 'subtle'))

  const title = data.searchText
    ? `⌘ 命令面板 — "${data.searchText}"`
    : '命令面板'
  lines.push(formatTitleLeft(title, width, theme))

  const maxItems = height - 5 // border + title + footer + border = 4; +1 safety
  const visible = data.commands.slice(0, maxItems)

  for (let i = 0; i < visible.length; i++) {
    const cmd = visible[i]!
    const isSelected = i === data.selectedIndex
    const prefix = isSelected
      ? color(CURSOR, theme.primary, { bold: true })
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

  lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Enter', '执行'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

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

  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title ?? '会话编年史', width, theme))

  const idxWidth = 6
  const timeWidth = Math.min(14, Math.floor(width * 0.18))
  const summaryWidth = width - 2 - idxWidth - timeWidth - 5

  const maxEntries = height - 5
  const visible = data.entries.slice(0, maxEntries)
  const sel = data.selectedIndex ?? -1

  for (let i = 0; i < visible.length; i++) {
    const entry = visible[i]!
    const selected = i === sel
    // 选中游标；当前会话用 primary 高亮（与选中区分：选中靠游标，当前靠色）。
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
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

  lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Enter', '恢复会话'], ['Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

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
  /** 累计工具调用次数（计数列；0 时省略）。 */
  toolUseCount?: number
  /** 累计 token 总数（计数列；0 时省略）。 */
  tokenCount?: number
  /** 终态后尚未查看——行首 unread 圆点标记。 */
  unread?: boolean
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

/** 状态 → 语义色（running 主色、passed 成功、failed 错误、blocked/escalated 警告）。 */
function taskStatusColor(status: TasksWorkerStatus, theme: RivetTheme): string {
  switch (status) {
    case 'running': return theme.primary
    case 'passed': return theme.success
    case 'failed': return theme.error ?? theme.warning
    default: return theme.warning
  }
}

/** done/total 进度条（复用 worker 面板风格）。 */
function tasksProgressBar(done: number, total: number, width = 10): string {
  if (total <= 0) return '░'.repeat(width)
  const filled = Math.min(width, Math.round((done / total) * width))
  return '█'.repeat(filled) + '░'.repeat(width - filled)
}

/** stringWidth 感知的 padEnd/截断：CJK/emoji 占 2 格也能对齐。 */
function fitDisplay(text: string, width: number): string {
  if (width <= 0) return ''
  let out = ''
  let w = 0
  for (const ch of text) {
    const cw = stringWidth(ch)
    if (w + cw > width) {
      // 溢出：末位补省略号（若有空间）
      if (w < width) { out += '…'; w += 1 }
      break
    }
    out += ch
    w += cw
  }
  return out + ' '.repeat(Math.max(0, width - w))
}

// ── Model Picker ───────────────────────────────────────────────

export interface ModelPickerEntry {
  id: string
  alias: string
  provider: string
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
  isDefault: boolean
  description: string
}

export interface ThemePickerData {
  entries: ThemePickerEntry[]
  selectedIndex: number
}

// ── Domain Picker ──────────────────────────────────────────────

export interface DomainPickerEntry {
  /** 选择键：'auto' | domain id */
  key: string
  /** 展示名（中文星域名或 Auto 标签） */
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
  lines.push(formatBorder(width, theme, 'subtle'))
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

    const cursor = selected ? color(CURSOR, currentAccent, { bold: true }) : ' '
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

  lines.push(formatFooter(compactHints([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '应用'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

/** filter 切换指示（标题栏内联 tab）：当前项高亮，其余 dim。 */
function tasksFilterTabs(filter: TasksFilter, theme: RivetTheme): string {
  const tabs: [TasksFilter, string][] = [['running', '运行中'], ['completed', '已完成'], ['all', '全部']]
  return tabs
    .map(([key, label]) => key === filter
      ? color(label, theme.primary, { bold: true })
      : color(label, theme.dim))
    .join(color(' · ', theme.dim))
}

export function renderTasks(
  data: TasksData,
  width: number,
  height: number,
  theme: RivetTheme,
  selectedIndex = -1,
): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(`${color('子代理任务', theme.secondary, { bold: true })}   ${tasksFilterTabs(data.filter, theme)}`, width, theme))
  lines.push(frameDivider(width, theme))

  const maxEntries = Math.max(1, height - 6) // top + title + divider + footer + bottom = 5, -1 安全余量

  // 逐组渲染：组头（进度条 + 语义色计数）后跟 worker 行。多组时以
  // 序号区分（parentToolId 是不透明的 tool id，不直接展示）。
  const body: string[] = []
  const selectable: { workerId: string; bodyIndex: number }[] = []
  const multiGroup = data.groups.length > 1
  const inner = width - 2

  data.groups.forEach((g, gi) => {
    // 组头：进度条填充段用语义色（全过→success，有失败→warning，其余→primary）
    const barColor = g.total > 0 && g.done === g.total ? theme.success
      : g.failed > 0 ? theme.warning
        : theme.primary
    const barW = 10
    const filledN = g.total > 0 ? Math.min(barW, Math.round((g.done / g.total) * barW)) : 0
    const bar = color('█'.repeat(filledN), barColor) + color('░'.repeat(barW - filledN), theme.dim)
    const countParts: string[] = [color(`${g.done}/${g.total} 完成`, theme.muted)]
    if (g.running > 0) countParts.push(color(`◐${g.running} 运行`, theme.primary))
    if (g.failed > 0) countParts.push(color(`✗${g.failed} 失败`, theme.warning))
    const groupTitle = multiGroup ? `批次 ${gi + 1}` : '任务组'
    body.push(` ${color('◆', theme.primary)} ${color(groupTitle, theme.secondary)}  ${bar}  ${countParts.join(color(' · ', theme.dim))}`)

    for (const w of g.workers) {
      selectable.push({ workerId: w.workerId, bodyIndex: body.length })
      const glyph = TASK_STATUS_GLYPH[w.status] ?? '·'
      const glyphColored = color(glyph, taskStatusColor(w.status, theme))
      // unread：终态但用户还没打开 detail —— 行首圆点提示（CC 未读结果对标）。
      // 无色纯字符：选中行会被 slice(3) 替换为光标前缀，带 ANSI 会被切坏。
      const unreadMark = w.unread ? '●' : ' '

      // 三段式：`  ●◐ label(固定列)  activity(弹性)  stats(右对齐)`
      const labelW = Math.min(22, Math.max(12, Math.floor(inner * 0.28)))
      const label = fitDisplay(`${w.shortLabel}·${w.profile}`, labelW)

      const statParts: string[] = []
      if (w.toolUseCount && w.toolUseCount > 0) statParts.push(`⚙${w.toolUseCount}`)
      if (w.tokenCount && w.tokenCount > 0) statParts.push(`${formatTokenCount(w.tokenCount)}tok`)
      statParts.push(formatElapsed(w.elapsedMs))
      let statsPlain = statParts.join(' · ')

      // prefix(2sp+unread+glyph+1sp=5) + label + 2 gap + activity + 2 gap + stats + 1 右边距
      let activityW = inner - 5 - labelW - 2 - stringWidth(statsPlain) - 3
      if (activityW < 4 && statParts.length > 1) {
        // 窄屏降级：只留耗时列
        statsPlain = statParts[statParts.length - 1]!
        activityW = inner - 5 - labelW - 2 - stringWidth(statsPlain) - 3
      }
      const activity = fitDisplay(w.activity ?? '', Math.max(0, activityW))
      const stats = color(statsPlain, theme.muted)
      const labelColored = w.status === 'running' ? label : color(label, theme.muted)
      body.push(`  ${unreadMark}${glyphColored} ${labelColored}  ${activity}  ${stats}`)
    }
    // 组间空行（最后一组后不加）
    if (gi < data.groups.length - 1) body.push('')
  })

  if (selectable.length === 0) {
    const emptyText = data.filter === 'completed' ? '（暂无已完成的子代理）'
      : data.filter === 'all' ? '（暂无子代理）'
        : '（暂无运行中的子代理 · Tab 切换筛选）'
    body.push('')
    body.push(color(`  ${emptyText}`, theme.muted))
  }

  const selectedBodyIndex = selectedIndex >= 0 && selectedIndex < selectable.length
    ? selectable[selectedIndex]!.bodyIndex
    : -1

  const visible = body.slice(0, maxEntries)
  for (let i = 0; i < visible.length; i++) {
    let line = visible[i]!
    if (i === selectedBodyIndex) {
      // 把前导三个空格替换为光标 + 两个空格，保持宽度一致
      line = `${color(CURSOR, theme.primary, { bold: true })}  ${line.slice(3)}`
    }
    lines.push(padLine(line, width, theme))
  }
  for (let i = visible.length; i < maxEntries; i++) {
    lines.push(padLine('', width, theme))
  }

  const runningCount = data.groups.reduce((n, g) => n + g.workers.filter(w => w.status === 'running').length, 0)
  const summaryParts: string[] = []
  if (data.filter === 'running' || data.filter === 'all') {
    summaryParts.push(`${runningCount} 运行中`)
  }
  if (data.filter === 'completed' || data.filter === 'all') {
    summaryParts.push(`${data.completedCount} 已完成`)
  }
  const summary = summaryParts.join(' · ')
  // 分隔符收紧为 " · "：frameFooter 溢出时从前截断，summary 在最前面，
  // f/x 键位加入后 80 列下过长会把计数吃掉。
  lines.push(formatFooter(`${summary} · ${compactHints([['↑↓', '选择'], ['Enter', '详情'], ['f', '切入'], ['x', '停止'], ['Tab', '筛选'], ['q/Esc', '关闭']])}`, width, theme))
  lines.push(formatBottomBorder(width, theme, 'subtle'))

  return lines
}

// ── Model Picker ───────────────────────────────────────────────

export function renderModelPicker(data: ModelPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
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
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const mark = e.current ? color(CURRENT_MARK, theme.primary) : ' '
    const aliasColor = selected ? color(e.alias, theme.primary, { bold: true }) : color(e.alias, theme.secondary)
    const providerColor = selected ? color(`[${e.provider}] `, theme.dim) : color(`[${e.provider}] `, theme.dim)
    const idText = ` [${e.id}]`
    const tokensText = e.contextWindow ? `  ${(e.contextWindow / 1000).toFixed(0)}k ctx` : ''
    const head = `${cursor} ${mark} ${providerColor}${aliasColor}${color(idText, theme.dim)}`

    const plainHead = `  ${e.current ? '●' : ' '} [${e.provider}] ${e.alias}${idText}`
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

  lines.push(formatFooter(compactHints([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '应用'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Theme Picker ───────────────────────────────────────────────

export function renderThemePicker(data: ThemePickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
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
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const mark = e.current ? color(CURRENT_MARK, theme.primary) : ' '
    const defaultMark = e.isDefault ? color('★', theme.warning, { bold: true }) : ' '
    const nameColor = selected ? color(e.name, theme.primary, { bold: true }) : color(e.name, theme.secondary)
    lines.push(padLine(`${cursor} ${mark} ${defaultMark} ${nameColor}`, width, theme))
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
    
    // 2. Swatch Preview!（resolveThemeEntry 同时覆盖内置与 custom: 主题）
    const targetThemeInfo = resolveThemeEntry(current.name)
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

  lines.push(formatFooter(compactHints([['←/→', '切换'], ['↑↓', '选择'], ['Enter', '应用'], ['S', '设为默认'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
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
  /** Marked with "← current" to show which option is the active/persisted one. */
  current?: boolean
}

export interface ChoicePanelData {
  /** Question / prompt shown as the title bar. */
  title: string
  choices: ChoiceEntry[]
  selectedIndex: number
  /** When active, a live text input box is rendered below the choices. */
  inputSubMode?: {
    active: boolean
    label: string
    placeholder: string
    value: string
  }
}

export function renderChoicePanel(data: ChoicePanelData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft(data.title, width, theme))
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6 // padLine border(2) + left indent(2) + right gap(2)
  const inputSubMode = data.inputSubMode?.active ? data.inputSubMode : undefined
  const inputRows = inputSubMode ? 2 : 0 // label line + input line
  const contentRows = Math.max(1, height - 5 - inputRows) // border + title + separator + footer + bottom = 5

  if (data.choices.length === 0) {
    lines.push(padLine(color('  （无可用选项）', theme.muted), width, theme))
    lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
    lines.push(formatBottomBorder(width, theme, 'subtle'))
    return lines
  }

  // Each choice takes 1-2 lines (label + optional description). Calculate
  // how many fit, with wrapping for long descriptions.
  let rowsUsed = 0
  for (let i = 0; i < data.choices.length; i++) {
    if (rowsUsed >= contentRows) break
    const c = data.choices[i]!
    const selected = i === data.selectedIndex

    // Label line: cursor + recommended star + label
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const star = c.recommended ? color('★', theme.warning ?? theme.primary, { bold: true }) : ' '
    const labelColor = selected ? theme.primary : theme.secondary
    const labelText = selected ? color(c.label, labelColor, { bold: true }) : color(c.label, labelColor)
    const currentMark = c.current ? ' ' + color('← current', theme.success) : ''
    lines.push(padLine(` ${cursor} ${star} ${labelText}${currentMark}`, width, theme))
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

  if (inputSubMode) {
    lines.push(frameDivider(width, theme))
    lines.push(padLine(` ${color(inputSubMode.label, theme.muted)}`, width, theme))
    const cursor = color('▏', theme.primary, { bold: true })
    const shown = inputSubMode.value.length > 0
      ? color(truncateToDisplayWidth(inputSubMode.value, Math.max(1, width - 8)), theme.secondary)
      : color(inputSubMode.placeholder, theme.dim)
    lines.push(padLine(` ${color('>', theme.primary, { bold: true })} ${shown}${cursor}`, width, theme))
    lines.push(formatFooter(compactHints([['↵', '提交'], ['Esc', '返回选项']]), width, theme, 'subtle'))
  } else {
    lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Enter', '确认'], ['Esc', '取消']]), width, theme, 'subtle'))
  }
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Plan Picker (/plan-approve 无参 · 待批计划选择器) ────────────────

export interface PlanPickerEntry {
  /** 选择键：plan slug（planPickerExec 收到它去 approve+kickoff）。 */
  slug: string
  title: string
  status: 'submitted' | 'approved' | 'executed' | 'rejected'
  /** 展示用创建时间（已本地化字符串）。 */
  createdAt: string
  /** 多方案计划的方案标签（可空）。 */
  options?: string[]
}

export interface PlanPickerData {
  entries: PlanPickerEntry[]
  selectedIndex: number
}

function planStatusIcon(status: PlanPickerEntry['status']): string {
  switch (status) {
    case 'approved': return '✅'
    case 'rejected': return '❌'
    case 'executed': return '🏁'
    default: return '📋'
  }
}

/**
 * 渲染 Plan Picker overlay（待批计划选择器）。
 * 列表（cursor + 状态图标 + title）→ 选中项 dim 元信息（slug · 时间 · 方案）。
 * 回车批准并自动分波执行（planPickerExec 收到 slug）。
 */
export function renderPlanPicker(data: PlanPickerData, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))
  lines.push(formatTitleLeft('选择要批准执行的计划', width, theme))
  lines.push(frameDivider(width, theme))

  const innerWidth = width - 6
  const contentRows = Math.max(1, height - 5)

  if (data.entries.length === 0) {
    lines.push(padLine(color('  （无待批计划。/plan-mode 进入计划模式创建）', theme.muted), width, theme))
    lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
    lines.push(formatBottomBorder(width, theme, 'subtle'))
    return lines
  }

  let rowsUsed = 0
  for (let i = 0; i < data.entries.length; i++) {
    if (rowsUsed >= contentRows) break
    const e = data.entries[i]!
    const selected = i === data.selectedIndex
    const icon = planStatusIcon(e.status)
    const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
    const labelColor = selected ? theme.primary : theme.secondary
    const title = selected ? color(e.title, labelColor, { bold: true }) : color(e.title, labelColor)
    lines.push(padLine(` ${cursor} ${icon} ${title}`, width, theme))
    rowsUsed++

    if (selected && rowsUsed < contentRows) {
      const optionsPart = e.options && e.options.length > 0 ? ` · 方案: ${e.options.join(' / ')}` : ''
      const meta = `${e.slug} · ${e.createdAt}${optionsPart}`
      for (const d of wrapToWidth(meta, innerWidth, 2)) {
        if (rowsUsed >= contentRows) break
        lines.push(padLine(`     ${color(d, theme.muted)}`, width, theme))
        rowsUsed++
      }
    }
  }

  while (rowsUsed < contentRows) {
    lines.push(padLine('', width, theme))
    rowsUsed++
  }

  lines.push(formatFooter(compactHints([['↑↓', '选择'], ['Enter', '批准执行'], ['Esc', '取消']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
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
  lines.push(formatBorder(width, theme, 'subtle'))
  const titleBar = view.stepLabel ? `${view.title}   ${view.stepLabel}` : view.title
  lines.push(formatTitleLeft(titleBar, width, theme))
  lines.push(frameDivider(width, theme))

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
      const cursor = selected ? color(CURSOR, theme.primary, { bold: true }) : ' '
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

  const footer = view.kind === 'choice'
    ? compactHints([['↑↓', '选择'], ['Enter', '确认'], ['Esc', '取消']])
    : compactHints([['Enter', '提交'], ['Esc', '取消']])
  lines.push(formatFooter(footer, width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}

// ── Fleet Detail (子代理详情弹窗) ───────────────────────────────
// Shows expanded details for a single delegation worker: profile, status,
// current activity, elapsed, authority. Triggered by pressing Enter on a
// worker row in the fleet panel.

import type { FleetWorkerView } from '../fleet-registry.js'

export function renderFleetDetail(worker: FleetWorkerView, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  lines.push(formatBorder(width, theme, 'subtle'))

  // Title: status glyph + worker label + status word（同色，一眼判断终态）
  const statusGlyph = worker.terminal
    ? (worker.status === 'passed' ? '✓' : worker.status === 'failed' ? '✗' : '⚠')
    : '◐'
  const statusColor = worker.terminal
    ? (worker.status === 'passed' ? theme.success : worker.status === 'failed' ? theme.error : theme.warning)
    : theme.primary
  lines.push(formatTitleLeft(
    `${color(`${statusGlyph} ${worker.shortLabel}`, statusColor, { bold: true })} ${color(`· ${worker.status}`, statusColor)}`,
    width, theme,
  ))
  lines.push(frameDivider(width, theme))

  // Detail rows：标签列右对齐固定宽度，值列对齐成表
  const rows: [string, string][] = []
  rows.push(['Profile', worker.profile])
  if (worker.authority) rows.push(['Authority', worker.authority])
  if (worker.model) rows.push(['Model', worker.model])
  rows.push(['Elapsed', formatElapsed(worker.elapsedMs)])
  const statBits: string[] = []
  if (worker.toolUseCount > 0) statBits.push(`⚙ ${worker.toolUseCount} tools`)
  if (worker.tokenCount > 0) statBits.push(`${formatTokenCount(worker.tokenCount)} tokens`)
  if (statBits.length > 0) rows.push(['Usage', statBits.join(' · ')])
  rows.push(['Parent', worker.parentToolId])

  const labelW = Math.max(...rows.map(([l]) => l.length))
  for (const [label, value] of rows) {
    lines.push(padLine(`  ${color(label.padStart(labelW), theme.muted)}  ${color(value, theme.secondary)}`, width, theme))
  }

  // Activity log (ring buffer — newest last; fallback to single activity line)
  const activityLog = worker.activityLog?.length ? worker.activityLog : (worker.activity ? [worker.activity] : [])
  if (activityLog.length > 0) {
    lines.push(padLine('', width, theme))
    lines.push(padLine(`  ${color('活动日志', theme.muted, { bold: true })}`, width, theme))
    // 高度预算内展示最新条目（newest last），末行留给 footer
    const room = Math.max(1, height - lines.length - 3)
    const shown = activityLog.slice(-room)
    for (const entry of shown) {
      lines.push(padLine(`    ${color('⎿', theme.dim)} ${color(entry, theme.secondary)}`, width, theme))
    }
  }

  // Pad to fill height
  const remaining = Math.max(0, height - lines.length - 3)
  for (let i = 0; i < remaining; i++) {
    lines.push(padLine('', width, theme))
  }

  lines.push(formatFooter(compactHints([['Esc', '关闭']]), width, theme, 'subtle'))
  lines.push(formatBottomBorder(width, theme, 'subtle'))
  return lines
}
