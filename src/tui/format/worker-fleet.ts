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

/**
 * 生成内联舰队面板的纯文本行（无颜色，便于测试）。
 * 第一行是汇总头，其后每行一个在跑 worker。
 */
export function buildWorkerFleetLines(
  workers: FleetWorkerView[],
  summary: WorkerFleetSummary | undefined,
  width = 80,
  maxRows = 6,
): string[] {
  const rule = Math.min(Math.max(40, width), 80)
  const lines: string[] = []

  const running = summary?.running ?? workers.filter(w => w.status === 'running').length
  if (summary && summary.total > 0) {
    const parts: string[] = []
    if (running > 0) {
      parts.push(`${running} 执行中`)
    }
    if (summary.done > 0) {
      parts.push(`${summary.done}/${summary.total} 完成`)
    }
    lines.push(` ◐ 子代理 · ${parts.join(' · ') || `${summary.total} 个`}`)
  } else {
    lines.push(` ◐ 子代理 · ${workers.length} 执行中`)
  }

  const visible = workers.slice(0, maxRows)
  const labels = assignLabels(visible)
  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const glyph = statusGlyph(w.status)
    const label = labels[i]!
    const elapsed = formatElapsed(w.elapsedMs)
    const head = `   ${glyph} ${label}`
    const tail = elapsed ? `  ${elapsed}` : ''
    const activityMax = rule - head.length - tail.length - 2
    const activity = w.activity ? ` ${truncate(w.activity, Math.max(0, activityMax))}` : ''
    lines.push(`${head}${activity}${tail}`)
  }

  const overflow = workers.length - visible.length
  if (overflow > 0) {
    lines.push(`   …(+${overflow})`)
  }

  return lines
}

/**
 * 渲染内联舰队面板为带色 ANSI 行：
 *  汇总头 → muted · running → primary · passed → success · 其余 → warning。
 */
export function formatWorkerFleet(
  workers: FleetWorkerView[],
  theme: RivetTheme,
  width = 80,
  summary?: WorkerFleetSummary,
  maxRows = 6,
): string[] {
  const plain = buildWorkerFleetLines(workers, summary, width, maxRows)
  if (plain.length === 0) return plain
  const out: string[] = []
  out.push(color(plain[0]!, theme.muted))
  const visible = workers.slice(0, maxRows)
  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const line = plain[i + 1]!
    if (w.status === 'running') out.push(color(line, theme.primary))
    else if (w.status === 'passed') out.push(color(line, theme.success))
    else out.push(color(line, theme.warning))
  }
  if (plain.length > visible.length + 1) {
    out.push(color(plain[plain.length - 1]!, theme.muted))
  }
  return out
}
