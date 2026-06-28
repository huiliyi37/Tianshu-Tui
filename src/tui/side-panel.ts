/**
 * T9 右侧可折叠状态面板 — OpenCode 风格任务/状态概览。
 *
 * 默认折叠，由 TuiApp 根据用户命令/快捷键控制是否渲染。
 * 内容分块：当前工具、任务列表、Worker 舰队、当前计划、指标、快捷键提示。
 *
 * 纯函数输出：接收数据 → 返回格式化行数组（含 ANSI）。
 */

import type { RivetTheme } from './theme.js'
import type { TodoItem } from '../tools/todo-store.js'
import type { FleetWorkerView } from './fleet-registry.js'
import { color } from './engine/ansi.js'
import { formatTokenProgressBar } from './format/glance-bar.js'
import { formatTaskList } from './format/task-list.js'
import stringWidth from 'string-width'

export interface SidePanelInput {
  /** 面板总宽度（含边框），通常 24-32 列 */
  columns: number
  todos: TodoItem[]
  workers: FleetWorkerView[]
  currentTool?: { name: string; elapsedMs: number }
  currentToolName?: string
  currentToolElapsedMs?: number
  modelName?: string
  domainGlyph?: string
  domainName?: string
  estimatedTokens?: number
  maxTokens?: number
  cacheHitRate?: number
  cost?: number
  /** 当前已批准计划指针（XML 字符串），可选 */
  activePlan?: string
}

/** 最多展示的 worker 行数（超出截断）。 */
const MAX_WORKERS = 5

/** 任务区最大行数（含标题与摘要）。 */
const MAX_TASK_ROWS = 6

/**
 * 渲染右侧面板为固定宽度的行数组。
 * 顶部用 ╭─╮ 线框，底部 ╰─╯ 收束。
 * 返回的每行已包含左边框 `│ ` 前缀，适合拼接到主内容右侧。
 */
export function renderSidePanel(input: SidePanelInput, theme: RivetTheme): string[] {
  const totalW = input.columns
  if (totalW < 16) return [] // 太窄不渲染
  const contentW = totalW - 4 // 减去边框占用的 4 列：│ _content_ │

  const lines: string[] = []
  const h = '─'
  const topBorder = color(`╭${h.repeat(totalW - 2)}╮`, theme.muted)
  const botBorder = color(`╰${h.repeat(totalW - 2)}╯`, theme.muted)
  const leftEdge = color('│', theme.muted)

  const pad = (text: string, target: number): string => {
    const dw = stringWidth(text)
    if (dw >= target) return text.slice(0, Math.max(0, target - 1)) + '…'
    return text + ' '.repeat(target - dw)
  }

  const line = (content: string): string =>
    `${leftEdge} ${pad(content, contentW)} ${leftEdge}`

  const dim = (s: string) => color(s, theme.dim)
  const muted = (s: string) => color(s, theme.muted)
  const sectionDivider = () => line(muted('─'.repeat(contentW)))

  // 归一化 currentTool
  const toolName = input.currentTool?.name ?? input.currentToolName
  const toolElapsed = input.currentTool?.elapsedMs ?? input.currentToolElapsedMs

  lines.push(topBorder)

  // ── Section: 星域 + 模型摘要 ──
  if (input.domainGlyph || input.domainName) {
    const glyph = input.domainGlyph ?? ''
    const name = input.domainName ?? ''
    lines.push(line(`${glyph} ${name}`))
  }
  if (input.modelName) {
    lines.push(line(muted(`model: ${truncateStr(input.modelName, contentW - 7)}`)))
  }

  // ── Section: 当前工具 ──
  if (toolName) {
    const elapsed = toolElapsed ? ` ${formatElapsedShort(toolElapsed)}` : ''
    lines.push(sectionDivider())
    lines.push(line(color('⚙ 工具', theme.secondary, { bold: true })))
    lines.push(line(`${color('⚙', theme.secondary)} ${truncateStr(toolName, contentW - 4)}${dim(elapsed)}`))
  }

  // ── Section: 任务列表（复用 formatTaskList）──
  lines.push(sectionDivider())
  const taskLines = formatTaskList(input.todos, theme, { width: contentW, maxRows: MAX_TASK_ROWS })
  if (taskLines.length > 0) {
    for (const taskLine of taskLines) {
      lines.push(line(taskLine))
    }
  } else {
    lines.push(line(color('◇ 任务 [░░░░░░░░] 0/0', theme.secondary, { bold: true })))
    lines.push(line(muted('  暂无任务')))
  }

  // ── Section: Worker 舰队 ──
  if (input.workers.length > 0) {
    lines.push(sectionDivider())
    lines.push(line(color(input.workers.length === 1 ? '◆ worker' : `◆ workers (${input.workers.length})`, theme.secondary, { bold: true })))
    const shown = input.workers.slice(0, MAX_WORKERS)
    for (const wrk of shown) {
      const statusIcon = wrk.terminal ? '✓' : wrk.status === 'failed' ? '✗' : '●'
      const statusColor = wrk.terminal ? theme.success : wrk.status === 'failed' ? theme.error : theme.primary
      const label = truncateStr(wrk.shortLabel, 8)
      const profile = truncateStr(wrk.profile, 8)
      const elapsed = formatElapsedShort(wrk.elapsedMs)
      const row = `${color(statusIcon, statusColor)} ${label} ${dim(profile)} ${muted(elapsed)}`
      lines.push(line(row))
    }
    if (input.workers.length > MAX_WORKERS) {
      lines.push(line(muted(`... +${input.workers.length - MAX_WORKERS} more`)))
    }
  }

  // ── Section: 当前已批准计划 ──
  const plan = parseActivePlan(input.activePlan)
  if (plan) {
    lines.push(sectionDivider())
    lines.push(line(color('◈ 计划', theme.secondary, { bold: true })))
    lines.push(line(truncateStr(plan.title, contentW)))
    lines.push(line(dim(truncateStr(plan.path, contentW))))
  }

  // ── Section: Token 仪表 ──
  if (input.estimatedTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    lines.push(sectionDivider())
    lines.push(line(color('◧ 上下文', theme.secondary, { bold: true })))
    const ratio = Math.min(1, input.estimatedTokens / input.maxTokens)
    lines.push(line(formatTokenProgressBar(ratio, theme)))
    const costStr = input.cost !== undefined && input.cost > 0
      ? `  ${input.cost.toFixed(2)}` : ''
    lines.push(line(dim(`${formatTokensCompact(input.estimatedTokens)} / ${formatTokensCompact(input.maxTokens)}${costStr}`)))
  }

  // 缓存命中率指示
  if (input.cacheHitRate !== undefined) {
    lines.push(sectionDivider())
    const cp = (input.cacheHitRate * 100).toFixed(0)
    const cacheColor = input.cacheHitRate < 0.5 ? theme.warning : theme.muted
    lines.push(line(`${color(`cache ${cp}%`, cacheColor)}`))
  }

  // ── Section: 快捷键提示 ──
  lines.push(sectionDivider())
  lines.push(line(dim('] toggle · ctrl+x r open')))

  lines.push(botBorder)
  return lines
}

/** 轻量解析已批准计划指针，仅提取标题与路径。 */
function parseActivePlan(pointer: string | undefined): { title: string; path: string } | null {
  if (!pointer) return null
  const titleMatch = pointer.match(/title="([^"]*)"/)
  const pathMatch = pointer.match(/path="([^"]*)"/)
  if (!titleMatch && !pathMatch) return null
  const title = decodeXmlEntities(titleMatch?.[1] ?? '')
  const path = decodeXmlEntities(pathMatch?.[1] ?? '')
  if (!title && !path) return null
  return { title: title || 'Untitled plan', path: path || '' }
}

function decodeXmlEntities(s: string): string {
  return s
    .replace(/&quot;/g, '"')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
}

function truncateStr(s: string, max: number): string {
  if (max <= 0) return ''
  const dw = stringWidth(s)
  if (dw <= max) return s
  if (max <= 3) return '…'
  return s.slice(0, max - 1) + '…'
}

function formatTokensCompact(n: number): string {
  if (n >= 1_000_000) {
    const m = n / 1_000_000
    return m >= 10 ? `${Math.round(m)}M` : `${m.toFixed(1)}M`
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return `${n}`
}

function formatElapsedShort(ms: number): string {
  if (ms < 60000) return `${Math.floor(ms / 1000)}s`
  const mins = Math.floor(ms / 60000)
  const secs = Math.floor((ms % 60000) / 1000)
  return `${mins}m${secs}s`
}
