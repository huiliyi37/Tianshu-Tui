/**
 * Collapsed Polling Group — 轮询型工具同名连击折叠为一张聚合卡。
 *
 * 背景（known-issue 2026-09-04 P1）：主控陷入 `job(list)`/`browser_debug` 等
 * 观察型工具的成功型轮询时，每次调用的终态都 commit 一张工具卡，终端被刷到
 * 不可用。折叠集与 agent 侧 `pollingClassOf` 的观察型工具族、桌面端
 * `POLLING_FOLD_TOOLS` 同集：job / monitor / browser_debug / browser /
 * computer_use / ask_image。read/grep 等探索工具已有 read+search 折叠组，
 * 轮询是独立连击（同工具名连续调用才折叠），不进那个组。
 *
 * 连击语义：同一工具名连续调用折叠；异名工具（含另一个轮询工具）、assistant
 * 文本、用户消息、回合结束打断并 flush 成一张聚合卡。中间轮边界（工具批之间
 * 的 turn_complete）刻意不打断——跨轮静默连击正是折叠目标，逐轮 flush 会让
 * 100× job(list) 仍是 100 张卡。
 *
 * 温跃层设计（同 collapsed-read-search / collapsed-bash）：
 *   CollapsedPollingBuffer（状态管理）↔ app.ts（事件驱动）
 *   formatCollapsedPollingGroup（scrollback 落版）↔ formatCollapsedPollingGroupLive（live 聚合）
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'
import { hiddenLinesMarker } from './hidden-lines.js'
import { EXPAND_HINT } from '../truncation-marker.js'
import { formatElapsed } from '../tool-elapsed.js'

// ── Types ──────────────────────────────────────────────────────

export interface CollapsedPollingEntry {
  /** tool_use_id — 并行同名调用结果绑定的关键 */
  id: string
  toolName: string
  input: Record<string, unknown>
  /** 单次调用的可读标签（如 `list` / `await a1` / `screenshot`） */
  label: string
  content?: string
  isError?: boolean
  /** terminal result 已到达 */
  completed: boolean
  startMs: number
  endMs?: number
}

export interface CollapsedPollingGroup {
  /** 连击工具名——整组同名，异名到达即打断（buffer 外 flush） */
  toolName: string
  entries: CollapsedPollingEntry[]
  startMs: number
}

// ── Classification ─────────────────────────────────────────────

/**
 * 轮询折叠集。与 agent 侧 `pollingClassOf`（trace-store.ts）的观察型工具族
 * 及桌面端 event-reducer 的 POLLING_FOLD_TOOLS 同集——三处任一改动要同步。
 * bash 不在此列：它的轮询归并按命令类（agent 侧），TUI 侧已有可折叠 bash 组。
 */
const POLLING_FOLD_TOOLS: ReadonlySet<string> = new Set([
  'job', 'monitor', 'browser_debug', 'browser', 'computer_use', 'ask_image',
])

/** 工具是否进入轮询连击折叠（小写归一，对齐 pollingClassOf） */
export function isPollingFoldTool(toolName: string): boolean {
  return POLLING_FOLD_TOOLS.has(toolName.toLowerCase())
}

// ── Entry display ──────────────────────────────────────────────

/**
 * 单次调用的可读标签。折叠集工具的主参数几乎都是 `action` + 目标 id/选择器
 * （job: action+id；monitor: action+jobId；browser_debug: action+url/selector；
 * ask_image: id；computer_use: action）——取 action 与首个目标字段拼合。
 */
export function pollingEntryLabel(toolName: string, input: Record<string, unknown>): string {
  const action = typeof input.action === 'string' ? input.action : ''
  const target = [input.id, input.jobId, input.url, input.selector, input.expression]
    .find((v): v is string => typeof v === 'string' && v.length > 0)
  const label = action && target ? `${action} ${target}` : action || target || toolName
  return label.length > 50 ? label.slice(0, 49) + '…' : label
}

// ── Summary ────────────────────────────────────────────────────

export interface PollingGroupStats {
  total: number
  completed: number
  pending: number
  failed: number
  /** 最近一次已完成调用（live 行「最近 OK」与卡片最近明细的数据源） */
  lastCompleted: CollapsedPollingEntry | null
}

/** 从 entries 实时计算统计（不存储可变计数器，与 collapsed-read-search 同口径） */
export function computePollingStats(group: CollapsedPollingGroup): PollingGroupStats {
  let completed = 0
  let pending = 0
  let failed = 0
  let lastCompleted: CollapsedPollingEntry | null = null
  for (const entry of group.entries) {
    if (entry.completed) {
      completed++
      if (entry.isError) failed++
      lastCompleted = entry
    } else {
      pending++
    }
  }
  return { total: group.entries.length, completed, pending, failed, lastCompleted }
}

/**
 * 组摘要文本。
 * 落版（isActive=false）：`⏱ job 轮询 × 12（成功 11 / 失败 1）`
 * live（isActive=true）：`⏱ job ×12 · 最近 OK`（进行中无完成时「最近 进行中」）
 */
export function buildPollingSummaryText(group: CollapsedPollingGroup, isActive?: boolean): string {
  const stats = computePollingStats(group)
  if (isActive) {
    const last = stats.lastCompleted
    const recent = last ? (last.isError ? '最近失败' : '最近 OK') : '进行中'
    return `⏱ ${group.toolName} ×${stats.total} · ${recent}`
  }
  const parts: string[] = []
  if (stats.completed > 0) {
    parts.push(`成功 ${stats.completed - stats.failed}`)
    if (stats.failed > 0) parts.push(`失败 ${stats.failed}`)
  }
  if (stats.pending > 0) parts.push(`在途 ${stats.pending}`)
  const detail = parts.length > 0 ? `（${parts.join(' / ')}）` : ''
  return `⏱ ${group.toolName} 轮询 × ${stats.total}${detail}`
}

// ── Rendering: scrollback ──────────────────────────────────────

/** 展开形态最多列出的最近调用条数（更早的计数折叠，防 100+ 连击展开成新刷屏） */
export const POLLING_EXPAND_MAX_ENTRIES = 10
/** 展开形态每条调用预览的结果行数上限 */
const POLLING_EXPAND_CONTENT_LINES = 3

export interface FormatCollapsedPollingGroupInput {
  group: CollapsedPollingGroup
  expanded?: boolean
  theme: RivetTheme
  columns?: number
}

/** 渲染轮询连击聚合卡（scrollback 落版 / ctrl+o 展开） */
export function formatCollapsedPollingGroup(input: FormatCollapsedPollingGroupInput): string[] {
  const { group, expanded, theme } = input
  const lines: string[] = []
  const stats = computePollingStats(group)
  const summary = buildPollingSummaryText(group, false)
  const elapsed = Date.now() - group.startMs

  // 摘要行：展开指示器 + 摘要 + 耗时 + ctrl+o 提示（提示须在卡片文本内，
  // pager 的 scrollback-transcript 靠它识别「此卡可展开」）。
  const indicatorStr = color(expanded ? '▼' : '▶', theme.secondary, { bold: true })
  const summaryStr = color(summary, theme.primary, { bold: true })
  const elapsedCol = color(`· ${formatElapsed(elapsed)}`, theme.dim)
  const hintCol = expanded ? '' : ` ${color(EXPAND_HINT, theme.warning)}`
  lines.push(`${indicatorStr} ${summaryStr} ${elapsedCol}${hintCol}`)

  if (stats.completed === 0) {
    lines.push(`  ${color('│  (结果待达…)', theme.dim)}`)
    return lines
  }

  if (!expanded) {
    // 折叠态第二行：最近一次调用的标签 + 成败 + 结果首行（桌面端 tr-streak
    // 块保留最新结果的等价物——不看细节也知道轮询的最新状态）。
    const last = stats.lastCompleted!
    const glyph = last.isError ? color('✗', theme.error) : color('✓', theme.success)
    const firstLine = (last.content ?? '').replace(/\n+$/, '').split('\n')[0] ?? ''
    const maxWidth = Math.max(10, (input.columns ?? 80) - 12)
    const preview = displayWidth(firstLine) > maxWidth ? truncateToDisplayWidth(firstLine, maxWidth - 2) + '…' : firstLine
    lines.push(`  ${color('└─', theme.dim)} ${color(`最近 ${last.label}`, theme.secondary)} ${glyph}${preview ? ` ${color(preview, theme.muted)}` : ''}`)
    return lines
  }

  // 展开态：最近 N 条调用逐条列出（标签 + 成败 + 结果预览），更早的计数折叠。
  const completed = group.entries.filter(e => e.completed)
  const omitted = Math.max(0, completed.length - POLLING_EXPAND_MAX_ENTRIES)
  const shown = completed.slice(-POLLING_EXPAND_MAX_ENTRIES)
  if (omitted > 0) {
    lines.push(`  ${color('├─', theme.dim)} ${color(`… 早前 ${omitted} 次调用（已折叠）`, theme.dim)}`)
  }
  for (let i = 0; i < shown.length; i++) {
    const entry = shown[i]!
    const seq = group.entries.indexOf(entry) + 1
    const isLast = i === shown.length - 1
    const connector = color(isLast ? '└─' : '├─', theme.dim)
    const childPrefix = isLast ? '   ' : '│  '
    const glyph = entry.isError ? color('✗', theme.error) : color('✓', theme.success)
    const elapsedStr = entry.endMs !== undefined ? ` ${color(`(${formatElapsed(entry.endMs - entry.startMs)})`, theme.dim)}` : ''
    lines.push(`  ${connector} ${color(`#${seq} ${entry.label}`, theme.secondary)} ${glyph}${elapsedStr}`)
    if (entry.content) {
      const allLines = entry.content.replace(/\n+$/, '').split('\n')
      // 失败取尾部（报错原因通常在末尾），成功取头部——与 collapsed-bash 同口径。
      const previewLines = entry.isError ? allLines.slice(-POLLING_EXPAND_CONTENT_LINES) : allLines.slice(0, POLLING_EXPAND_CONTENT_LINES)
      const maxWidth = Math.max(10, (input.columns ?? 80) - childPrefix.length - 6)
      for (const pl of previewLines) {
        const trimmed = displayWidth(pl) > maxWidth ? truncateToDisplayWidth(pl, maxWidth - 2) + '…' : pl
        lines.push(`  ${childPrefix} ${color(trimmed, entry.isError ? theme.error : theme.muted)}`)
      }
      if (allLines.length > POLLING_EXPAND_CONTENT_LINES) {
        const note = hiddenLinesMarker(allLines.length - POLLING_EXPAND_CONTENT_LINES, entry.isError ? 'earlier' : 'hidden')
        lines.push(`  ${childPrefix} ${color(note, theme.dim)}`)
      }
    }
  }
  return lines
}

// ── Rendering: live region ─────────────────────────────────────

/**
 * 渲染 live 区轮询连击聚合行。连击进行中每次同名调用/结果更新该活行，
 * 而不是像普通工具卡那样逐次新增（live 区单行聚合，与 read/bash 组同形态）。
 */
export function formatCollapsedPollingGroupLive(
  group: CollapsedPollingGroup,
  theme: RivetTheme,
  columns?: number,
): string[] {
  const lines: string[] = []
  const summary = buildPollingSummaryText(group, true)
  const elapsed = Date.now() - group.startMs

  lines.push(`● ${color(summary, theme.muted)} ${color(`· ${formatElapsed(elapsed)}`, theme.muted)}`)

  // 最近一次已完成调用的末 2 行作进度预览（与 collapsed-read-search live 同形态）
  const stats = computePollingStats(group)
  if (stats.lastCompleted?.content) {
    const maxWidth = Math.max(10, (columns ?? 80) - 6)
    const tailLines = stats.lastCompleted.content.replace(/\n+$/, '').split('\n').slice(-2)
    for (const line of tailLines) {
      const trimmed = displayWidth(line) > maxWidth ? truncateToDisplayWidth(line, maxWidth - 1) + '…' : line
      lines.push(`  ${color(trimmed, theme.muted)}`)
    }
  }
  return lines
}

// ── Buffer ─────────────────────────────────────────────────────

/** 单条调用结果在组内的存储上限（聚合卡只展示摘要/预览，全量原文无留存价值） */
export const POLLING_ENTRY_CONTENT_MAX_CHARS = 4000

function capPollingContent(content: string): string {
  if (content.length <= POLLING_ENTRY_CONTENT_MAX_CHARS) return content
  return content.slice(0, POLLING_ENTRY_CONTENT_MAX_CHARS) + `\n…（聚合卡内截断，原 ${content.length} 字符）`
}

/**
 * CollapsedPollingBuffer — 管理轮询连击组的生命周期。
 *
 * 与 CollapsedReadSearchBuffer/CollapsedBashBuffer 同温跃层：buffer 只管状态，
 * 打断判定（异名工具/文本/用户消息/回合结束）与 flush 落版都在 app.ts。
 */
export class CollapsedPollingBuffer {
  private group: CollapsedPollingGroup | null = null

  /** 推入一次轮询调用；异名调用应在外部先 shouldBreak+flush（防御：此处直接重开） */
  pushUse(id: string, toolName: string, input: Record<string, unknown>): void {
    if (this.group && this.group.toolName !== toolName) {
      this.group = null
    }
    if (!this.group) {
      this.group = { toolName, entries: [], startMs: Date.now() }
    }
    this.group.entries.push({
      id,
      toolName,
      input,
      label: pollingEntryLabel(toolName, input),
      completed: false,
      startMs: Date.now(),
    })
  }

  /** 绑定 terminal result 到对应 entry（按 toolUseId，并行同名调用不串） */
  attachResult(id: string, content: string, isError?: boolean): CollapsedPollingEntry | null {
    if (!this.group) return null
    const entry = this.group.entries.find(e => e.id === id)
    if (!entry) return null
    entry.content = capPollingContent(content)
    entry.isError = isError ?? false
    entry.completed = true
    entry.endMs = Date.now()
    return entry
  }

  /** 新到达的 tool 是否打断当前连击（异名即断，含另一个轮询工具） */
  shouldBreak(toolName: string): boolean {
    return this.group !== null && this.group.toolName !== toolName
  }

  hasEntry(id: string): boolean {
    return this.group?.entries.some(e => e.id === id) ?? false
  }

  /** 取出当前组并清空 buffer（flush 到 scrollback） */
  flush(): CollapsedPollingGroup | null {
    const g = this.group
    this.group = null
    return g
  }

  /** 获取当前活跃组（不清空，用于 live 渲染和状态检查） */
  getActive(): CollapsedPollingGroup | null {
    return this.group
  }

  isActive(): boolean {
    return this.group !== null
  }

  hasPending(): boolean {
    return this.group?.entries.some(e => !e.completed) ?? false
  }
}
