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
import { formatWorkerRow } from './format/worker-fleet.js'
import { displayWidth, truncateToDisplayWidth } from './width.js'

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

  const AMBIGUOUS_WIDE = { ambiguousAsWide: true }
  const ELLIPSIS_WIDTH = displayWidth('…', AMBIGUOUS_WIDE)

  const pad = (text: string, target: number): string => {
    const dw = displayWidth(text, AMBIGUOUS_WIDE)
    if (dw > target) {
      if (target < ELLIPSIS_WIDTH) return ''
      const truncated = truncateToDisplayWidth(text, Math.max(0, target - ELLIPSIS_WIDTH), AMBIGUOUS_WIDE)
      return truncated + '…'
    }
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
  const taskLines = formatTaskList(input.todos, theme, { width: contentW, maxRows: MAX_TASK_ROWS, showProgressBar: false })
  if (taskLines.length > 0) {
    for (const taskLine of taskLines) {
      lines.push(line(taskLine))
    }
  } else {
    lines.push(line(color('◇ 任务 (0/0)', theme.secondary, { bold: true })))
    lines.push(line(muted('  暂无任务')))
  }

  // ── Section: Worker 舰队 ──
  if (input.workers.length > 0) {
    lines.push(sectionDivider())
    lines.push(line(color(input.workers.length === 1 ? '◆ worker' : `◆ workers (${input.workers.length})`, theme.secondary, { bold: true })))
    const shown = input.workers.slice(0, MAX_WORKERS)
    // 复用主区 formatWorkerRow：宽窄屏切换时字段（glyph/label/activity/elapsed）一致，
    // 不再各自维护一套渲染，消除「主区显示 activity、侧栏显示 shortLabel+profile」的突变。
    for (const wrk of shown) {
      lines.push(line(formatWorkerRow(wrk, theme, contentW)))
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
  lines.push(line(dim('ctrl+] toggle · ctrl+x r')))

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
  // 两阶段解码：先展开具名/数字实体，**最后**再把 &amp; → &。
  // 反过来（先解 &amp;）会让 "&amp;lt;" 被错解成 "<"：&amp; 先变 &，残留的 "lt;"
  // 虽不再被匹配，但顺序错误时 "&amp;lt;" 这类已转义过的二次输入会被破坏。
  // 数字实体（&#39; &#x27;）覆盖所有可打印字符，具名实体补齐 XML 五件套 + apos。
  return s
    .replace(/&#x([0-9a-fA-F]+);/g, (_, hex) => safeFromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => safeFromCodePoint(parseInt(dec, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
}

/** 数字实体还原：拒绝代理对（U+D800–DFFF）与超平面外的非法码点，避免生成乱码。 */
function safeFromCodePoint(cp: number): string {
  if (!Number.isFinite(cp) || cp < 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) return ''
  try { return String.fromCodePoint(cp) } catch { return '' }
}

function truncateStr(s: string, max: number): string {
  if (max <= 0) return ''
  const AMBIGUOUS_WIDE = { ambiguousAsWide: true }
  const ELLIPSIS_WIDTH = displayWidth('…', AMBIGUOUS_WIDE)
  const dw = displayWidth(s, AMBIGUOUS_WIDE)
  if (dw <= max) return s
  if (max < ELLIPSIS_WIDTH) return '…'
  const truncated = truncateToDisplayWidth(s, max - ELLIPSIS_WIDTH, AMBIGUOUS_WIDE)
  return truncated + '…'
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
