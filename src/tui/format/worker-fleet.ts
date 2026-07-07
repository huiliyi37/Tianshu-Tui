/**
 * T9 格式化函数 — 内联子代理舰队面板（live 区）。
 *
 * 从 FleetRegistry 的 per-worker 快照渲染一个紧凑的多行结构化总览。
 * 仅依赖 fleet-registry 视图类型 + ansi/theme + profile-labels，框架无关。
 *
 * 设计取舍：live 区寸土寸金，默认只展示在跑 worker（终态摘要随委派工具卡片
 * 进入 scrollback）。行数有上限，溢出折叠为 "…(+N)"。
 *
 * V2：去掉 UUID 前缀和英文 profile——用序号 #N + 中文职能名。
 *     去掉假进度条——用简洁计数行。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import { formatElapsed } from '../worker-panel-model.js'
import { profileLabel, authorityStarName } from './profile-labels.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

export interface WorkerFleetSummary {
  done: number
  total: number
  running: number
}

function statusGlyph(status: FleetWorkerView['status']): string {
  switch (status) {
    case 'running': return '◐'
    case 'passed': return '✓'
    case 'failed': return '✗'
    case 'blocked': return '⊗'
    case 'escalated': return '↑'
  }
}

/** 状态 → 主题色键：与主区/侧栏共用，保证宽窄屏切换时颜色不突变。 */
function statusColorKey(status: FleetWorkerView['status']): keyof RivetTheme {
  switch (status) {
    case 'running': return 'primary'
    case 'passed': return 'success'
    case 'failed': return 'error'
    default: return 'warning'
  }
}

function truncate(text: string, max: number): string {
  if (max <= 0) return ''
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/**
 * 为 worker 列表分配序号：同 profile 内从 1 开始递增。
 * 单个 profile 只有一个 worker 时不显示序号。
 */
function assignLabels(workers: FleetWorkerView[]): string[] {
  const profileCount = new Map<string, number>()
  const profileSeen = new Map<string, number>()
  // 第一遍：统计每个 profile 出现次数
  for (const w of workers) {
    profileCount.set(w.profile, (profileCount.get(w.profile) ?? 0) + 1)
  }
  // 第二遍：分配标签
  return workers.map(w => {
    const profile = profileLabel(w.profile)
    const star = authorityStarName(w.authority)
    const label = star ? `${star} · ${profile}` : profile
    const count = profileCount.get(w.profile) ?? 1
    if (count <= 1) return label
    const seq = (profileSeen.get(w.profile) ?? 0) + 1
    profileSeen.set(w.profile, seq)
    return `${label} #${seq}`
  })
}

/** 紧凑 token 数：1234 → "1.2k"，890 → "890"。 */
function fmtTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface FleetLine {
  text: string
  kind: 'header' | 'worker' | 'activity' | 'overflow'
  status?: FleetWorkerView['status']
}

/**
 * 树形两行结构（CC Task 进度对标）：
 *  分支行 `├─/└─ glyph label · N 工具 · Xk tok · elapsed`
 *  活动行 `│  ⎿ 最新活动`（末支用空白续行；无活动时省略）
 */
function buildEntries(
  workers: FleetWorkerView[],
  summary: WorkerFleetSummary | undefined,
  width: number,
  maxRows: number,
): FleetLine[] {
  const rule = Math.min(Math.max(40, width), 80)
  const lines: FleetLine[] = []

  const running = summary?.running ?? workers.filter(w => w.status === 'running').length
  if (summary && summary.total > 0) {
    const parts: string[] = []
    if (running > 0) {
      parts.push(`${running} 执行中`)
    }
    if (summary.done > 0) {
      parts.push(`${summary.done}/${summary.total} 完成`)
    }
    lines.push({ text: ` ◐ 子代理 · ${parts.join(' · ') || `${summary.total} 个`}`, kind: 'header' })
  } else {
    lines.push({ text: ` ◐ 子代理 · ${workers.length} 执行中`, kind: 'header' })
  }

  const visible = workers.slice(0, maxRows)
  const overflow = workers.length - visible.length
  const labels = assignLabels(visible)
  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const isLast = i === visible.length - 1 && overflow <= 0
    const branch = isLast ? '└─' : '├─'
    const cont = isLast ? '  ' : '│ '
    const glyph = statusGlyph(w.status)
    const label = labels[i]!
    const elapsed = formatElapsed(w.elapsedMs)

    // 计数段（CC AgentProgress 对标）：工具调用数 + token 数，缺省时省略
    const stats: string[] = []
    if (w.toolUseCount > 0) stats.push(`${w.toolUseCount} 工具`)
    if (w.tokenCount > 0) stats.push(`${fmtTokens(w.tokenCount)} tok`)
    const statsStr = stats.length > 0 ? ` · ${stats.join(' · ')}` : ''
    const tail = elapsed ? `  ${elapsed}` : ''
    lines.push({ text: ` ${branch} ${glyph} ${label}${statsStr}${tail}`, kind: 'worker', status: w.status })

    if (w.activity) {
      const head = ` ${cont}   ⎿ `
      const budget = Math.max(0, rule - head.length - 1)
      lines.push({ text: `${head}${truncate(w.activity, budget)}`, kind: 'activity', status: w.status })
    }
  }

  if (overflow > 0) {
    lines.push({ text: ` └─ …(+${overflow})`, kind: 'overflow' })
  }

  return lines
}

/**
 * 生成内联舰队面板的纯文本行（无颜色，便于测试）。
 * 第一行是汇总头，其后每个 worker 一到两行（分支行 + 可选活动行）。
 */
export function buildWorkerFleetLines(
  workers: FleetWorkerView[],
  summary: WorkerFleetSummary | undefined,
  width = 80,
  maxRows = 6,
): string[] {
  return buildEntries(workers, summary, width, maxRows).map(l => l.text)
}

/**
 * 渲染内联舰队面板为带色 ANSI 行：
 *  汇总头/折叠/活动行 → muted · running → primary · passed → success · 其余 → warning。
 */
export function formatWorkerFleet(
  workers: FleetWorkerView[],
  theme: RivetTheme,
  width = 80,
  summary?: WorkerFleetSummary,
  maxRows = 6,
): string[] {
  const entries = buildEntries(workers, summary, width, maxRows)
  return entries.map(l => {
    if (l.kind === 'worker') {
      if (l.status === 'running') return color(l.text, theme.primary)
      if (l.status === 'passed') return color(l.text, theme.success)
      return color(l.text, theme.warning)
    }
    return color(l.text, theme.muted)
  })
}

/**
 * 渲染单个 worker 行（带色 ANSI）—— 主区与侧栏共用，保证宽窄屏切换时字段不突变。
 *
 * 字段顺序与 formatWorkerFleet 单行一致：`glyph label [activity] elapsed`
 *  - glyph：statusGlyph（◐/✓/✗/⊗/↑）
 *  - label：星名 · 中文职能名（同主区）
 *  - activity：仅当 width 充足时显示（窄列省略，避免挤压 label）
 *  - elapsed：formatElapsed
 *  - 颜色：statusColorKey（running=primary / passed=success / failed=error / 其余=warning）
 *
 * @param worker 单个 worker 视图
 * @param theme 主题
 * @param width 该行可用宽度（display-width 口径，含 ambiguousAsWide）。≤0 时不渲染。
 */
export function formatWorkerRow(worker: FleetWorkerView, theme: RivetTheme, width: number): string {
  if (width <= 0) return ''
  const WIDE = { ambiguousAsWide: true }
  const glyph = statusGlyph(worker.status)
  const star = authorityStarName(worker.authority)
  const labelBase = star ? `${star} · ${profileLabel(worker.profile)}` : profileLabel(worker.profile)
  const elapsed = formatElapsed(worker.elapsedMs)
  const colorKey = statusColorKey(worker.status)
  // theme[colorKey] 在类型上是 string | 函数（部分主题键是 formatter），但语义色键
  // （primary/success/error/warning/muted/dim）恒为 ANSI 字符串。断言为 string 即可。
  const accent = theme[colorKey] as string

  // 头部：`  glyph label`（前导 2 空格与主区缩进一致）
  const head = `   ${glyph} ${labelBase}`
  const tail = elapsed ? `  ${elapsed}` : ''
  // activity 仅在剩余空间 ≥ 6 列（含分隔）时显示，否则省略。
  const headW = displayWidth(head, WIDE)
  const tailW = displayWidth(tail, WIDE)
  const activityBudget = width - headW - tailW - 2
  let activity = ''
  if (worker.activity && activityBudget >= 6) {
    const ellipsisW = displayWidth('…', WIDE)
    activity = ' ' + (displayWidth(worker.activity, WIDE) > activityBudget
      ? `${truncateToDisplayWidth(worker.activity, activityBudget - ellipsisW, WIDE)}…`
      : worker.activity)
  }
  return color(`${head}${activity}${tail}`, accent)
}
