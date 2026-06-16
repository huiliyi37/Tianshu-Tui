/**
 * T9 格式化函数 — 内联子代理舰队面板（live 区）。
 *
 * 从 FleetRegistry 的 per-worker 快照渲染一个紧凑的多行结构化总览，取代原来
 * 工具级单行 worker pills。仅依赖 fleet-registry 视图类型 + ansi/theme，框架无关。
 *
 * 设计取舍：live 区寸土寸金，默认只展示在跑 worker（终态摘要随委派工具卡片
 * 进入 scrollback）。行数有上限，溢出折叠为 "…(+N)"。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import { formatElapsed, progressBar } from '../worker-panel-model.js'

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
 * 生成内联舰队面板的纯文本行（无颜色，便于测试）。
 * 第一行是汇总头（进度条 + done/total + running 计），其后每行一个在跑 worker。
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
    const bar = progressBar(summary.done, summary.total)
    lines.push(` Agents ${bar} ${summary.done}/${summary.total}  ${running} running`)
  } else {
    lines.push(` Agents ·${workers.length}`)
  }

  const visible = workers.slice(0, maxRows)
  for (const w of visible) {
    const glyph = statusGlyph(w.status)
    const label = `${w.shortLabel}·${w.profile}`
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
 *  汇总头 → muted · running glyph → primary · passed → success · 其余 → warning。
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
  // worker 行与 plain 行一一对应（除头行与可能的 overflow 行）。
  const visible = workers.slice(0, maxRows)
  for (let i = 0; i < visible.length; i++) {
    const w = visible[i]!
    const line = plain[i + 1]!
    if (w.status === 'running') out.push(color(line, theme.primary))
    else if (w.status === 'passed') out.push(color(line, theme.success))
    else out.push(color(line, theme.warning))
  }
  // overflow 行（若有）取 muted
  if (plain.length > visible.length + 1) {
    out.push(color(plain[plain.length - 1]!, theme.muted))
  }
  return out
}
