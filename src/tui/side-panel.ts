/**
 * T9 右侧持久面板 — 非模态信息展示。
 *
 * 在宽终端（≥100 列）时，于主区域右侧渲染一个固定宽度的信息面板。
 * 内容：todo 列表、worker 舰队、当前工具、模型/域摘要、token 仪表。
 *
 * 纯函数输出：接收数据 → 返回格式化行数组（含 ANSI）。
 */

import type { RivetTheme } from './theme.js'
import type { TodoItem } from '../tools/todo-store.js'
import type { FleetWorkerView } from './fleet-registry.js'
import { color } from './engine/ansi.js'
import { formatTokenProgressBar } from './format/glance-bar.js'
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
}

/** 最多展示的 worker 行数（超出截断）。 */
const MAX_WORKERS = 6

/** 最多展示的 todo 行数。 */
const MAX_TODOS = 5

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

  // 归一化 currentTool
  const toolName = input.currentTool?.name ?? input.currentToolName
  const toolElapsed = input.currentTool?.elapsedMs ?? input.currentToolElapsedMs

  lines.push(topBorder)

  // ── 区块 1：星域 + 模型摘要 ──
  if (input.domainGlyph || input.domainName) {
    const glyph = input.domainGlyph ?? ''
    const name = input.domainName ?? ''
    lines.push(line(`${glyph} ${name}`))
  }
  if (input.modelName) {
    lines.push(line(muted(`model: ${truncateStr(input.modelName, contentW - 7)}`)))
  }

  // ── 区块 2：Token 仪表 ──
  if (input.estimatedTokens !== undefined && input.maxTokens && input.maxTokens > 0) {
    const ratio = Math.min(1, input.estimatedTokens / input.maxTokens)
    const bar = formatTokenProgressBar(ratio, theme)
    lines.push(line(muted('─'.repeat(contentW))))
    lines.push(line(bar))
    const costStr = input.cost !== undefined && input.cost > 0
      ? `  ${input.cost.toFixed(2)}` : ''
    lines.push(line(dim(`${formatTokensCompact(input.estimatedTokens)} / ${formatTokensCompact(input.maxTokens)}${costStr}`)))
  } else {
    lines.push(line(muted('─'.repeat(contentW))))
  }

  // ── 区块 3：当前工具 ──
  if (toolName) {
    const elapsed = toolElapsed ? ` ${formatElapsedShort(toolElapsed)}` : ''
    lines.push(line(muted('─'.repeat(contentW))))
    lines.push(line(`${color('⚙', theme.secondary)} ${truncateStr(toolName, contentW - 4)}${dim(elapsed)}`))
  }

  // ── 区块 4：Worker 舰队 ──
  if (input.workers.length > 0) {
    lines.push(line(muted('─'.repeat(contentW))))
    const header = input.workers.length === 1 ? 'worker' : `workers (${input.workers.length})`
    lines.push(line(muted(header)))
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

  // ── 区块 5：Todo 列表 ──
  const activeTodos = input.todos.filter(t => t.status !== 'completed')
  if (activeTodos.length > 0) {
    lines.push(line(muted('─'.repeat(contentW))))
    lines.push(line(muted(`tasks (${activeTodos.length})`)))
    const shown = activeTodos.slice(0, MAX_TODOS)
    for (const todo of shown) {
      const icon = todo.status === 'in_progress' ? color('▸', theme.primary) : color('○', theme.muted)
      const text = truncateStr(todo.content, contentW - 4)
      lines.push(line(`${icon} ${text}`))
    }
    if (activeTodos.length > MAX_TODOS) {
      lines.push(line(muted(`... +${activeTodos.length - MAX_TODOS} more`)))
    }
  }

  // 缓存命中率指示
  if (input.cacheHitRate !== undefined) {
    const cp = (input.cacheHitRate * 100).toFixed(0)
    const cacheColor = input.cacheHitRate < 0.5 ? theme.warning : theme.muted
    lines.push(line(muted('─'.repeat(contentW))))
    lines.push(line(`${color(`cache ${cp}%`, cacheColor)}`))
  }

  lines.push(botBorder)
  return lines
}

function truncateStr(s: string, max: number): string {
  if (max <= 0) return ''
  const dw = stringWidth(s)
  if (dw <= max) return s
  // 简单字符截断（对 ASCII 足够），3 留给省略号
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
