/**
 * T9 格式化函数 — worker 切入视图（CC teammate 视图对标）。
 *
 * viewingWorkerId 激活时替换 live 区的子代理汇总块：header（身份 + 计数 +
 * 键位提示）+ 最近镜像消息 tail。纯函数，框架无关。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { FleetWorkerView } from '../fleet-registry.js'
import type { MirrorMessage } from '../worker-mirror.js'
import { formatElapsed } from '../worker-panel-model.js'
import { profileLabel, authorityStarName } from './profile-labels.js'
import { formatTokenCount } from './spinner-status.js'
import { displayWidth, truncateToDisplayWidth } from '../width.js'

const WIDE = { ambiguousAsWide: true }

function clamp(text: string, max: number): string {
  if (max <= 0) return ''
  if (displayWidth(text, WIDE) <= max) return text
  return `${truncateToDisplayWidth(text, Math.max(0, max - 2), WIDE)}…`
}

/** 单条镜像消息 → 一行显示（text 取末行，tool 加 glyph）。 */
function messageLine(m: MirrorMessage): { text: string; kind: MirrorMessage['kind'] } {
  if (m.kind === 'tool_use') return { text: `⚙ ${m.content}`, kind: m.kind }
  if (m.kind === 'tool_result') return { text: `✓ ${m.content}`, kind: m.kind }
  if (m.kind === 'status') return { text: m.content, kind: m.kind }
  // text：多行取最后一段非空行（tail 视图只要最新语义）
  const lines = m.content.split('\n').map(l => l.trim()).filter(Boolean)
  return { text: lines[lines.length - 1] ?? '', kind: 'text' }
}

/**
 * 渲染 worker 切入视图（带色 ANSI 行）。
 *
 * @param view fleet 实时视图（身份/状态/计数）
 * @param messages 镜像消息（新在后）
 * @param maxRows 视图总行数上限（含 header/footer）
 */
export function formatWorkerView(
  view: FleetWorkerView,
  messages: MirrorMessage[],
  theme: RivetTheme,
  width = 80,
  maxRows = 10,
): string[] {
  const rule = Math.min(Math.max(40, width), 100)
  const out: string[] = []

  const star = authorityStarName(view.authority)
  const label = star ? `${star} · ${profileLabel(view.profile)}` : profileLabel(view.profile)
  const stats: string[] = []
  if (view.toolUseCount > 0) stats.push(`${view.toolUseCount} 工具`)
  if (view.tokenCount > 0) stats.push(`${formatTokenCount(view.tokenCount)} tok`)
  const statsStr = stats.length > 0 ? ` · ${stats.join(' · ')}` : ''
  const elapsed = formatElapsed(view.elapsedMs)
  const statusGlyph = view.terminal ? (view.status === 'passed' ? '✓' : '✗') : '◐'

  const headText = ` ╭─ ${statusGlyph} ${label} (${view.shortLabel})${statsStr} · ${elapsed}`
  const hint = view.terminal ? 'Esc 退出' : 'Esc 退出 · 输入直达'
  const headBudget = rule - displayWidth(hint, WIDE) - 4
  const head = `${clamp(headText, headBudget)} ${color(hint, theme.dim)}`
  out.push(color(head, view.terminal ? theme.muted : theme.secondary))

  // 消息 tail：预算 = maxRows - header - footer
  const bodyRows = Math.max(1, maxRows - 2)
  const tail = messages.slice(-bodyRows)
  if (tail.length === 0) {
    out.push(` ${color('│', theme.muted)} ${color('（尚无消息 — worker 正在启动）', theme.muted)}`)
  }
  for (const m of tail) {
    const line = messageLine(m)
    const budget = rule - 5
    const body = clamp(line.text, budget)
    const tint = line.kind === 'text' ? theme.assistantColor
      : line.kind === 'status' ? theme.warning
        : theme.muted
    out.push(` ${color('│', theme.muted)} ${color(body, tint)}`)
  }

  const footText = view.terminal
    ? ` ╰─ 已结束（${view.status}）`
    : ' ╰─ 输入将直达该子代理（/ 命令仍归主会话）'
  out.push(color(footText, theme.dim))
  return out
}
