/**
 * T9 Cockpit overlay — ANSI 渲染器。
 *
 * 消费 buildCockpitSnapshot() 的 CockpitSnapshot 数据，渲染纯 ANSI 仪表盘 overlay。
 * 采用统一面板骨架（overlay-frame），配色统一走主题（不再硬编码十六进制）。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { CockpitSnapshot, PanelStatus, Panel } from '../cockpit/types.js'
import { PANELS, PANEL_LABELS } from '../cockpit/types.js'
import {
  frameTop,
  frameBottom,
  frameTitle,
  frameFooter,
  frameLine,
} from './overlay-frame.js'

function statusGlyph(s: PanelStatus, theme: RivetTheme): string {
  switch (s) {
    case 'ok': return color('✓', theme.success)
    case 'warn': return color('⚠', theme.warning)
    case 'error': return color('✗', theme.error)
    case 'idle': return color('○', theme.dim)
    default: return '?'
  }
}

function formatBar(value: number, max: number, width: number, theme: RivetTheme): string {
  const ratio = Math.min(1, Math.max(0, value / max))
  const filled = Math.round(ratio * width)
  const empty = width - filled
  const barColor = ratio > 0.9 ? theme.error : ratio > 0.7 ? theme.warning : theme.success
  return color('█'.repeat(filled), barColor) + color('░'.repeat(empty), theme.dim)
}

export function renderCockpit(snapshot: CockpitSnapshot, width: number, height: number, theme: RivetTheme, panel: Panel = 'summary'): string[] {
  const w = Math.max(20, width - 4) // inner content width
  const contentRows = Math.max(3, height - 4) // top + title + footer + bottom
  // panel === 'summary'（或缺省）渲染全部；指定单面板时仅渲染该节（聚焦视图）。
  const show = (p: Panel): boolean => panel === 'summary' || panel === p

  const body: string[] = []

  // Panel rail — 显示可切换的子面板，当前面板高亮（/cockpit <panel> 切换）。
  const rail = PANELS.map(p => p === panel
    ? color(`[${PANEL_LABELS[p]}]`, theme.primary, { bold: true })
    : color(` ${PANEL_LABELS[p]} `, theme.dim)).join('')
  body.push(` ${rail}`)

  if (show('safety')) {
    body.push('')
    body.push(` ${statusGlyph(snapshot.panelStatuses.safety, theme)} ${color('Safety', theme.primary, { bold: true })}  ${color(snapshot.safety.riskLevel, theme.muted)}  doom:${snapshot.safety.doomLoopLevel}`)
    if (snapshot.safety.suggestedAction) {
      body.push(`    ${color(snapshot.safety.suggestedAction, theme.muted)}`)
    }
  }

  if (show('verify')) {
    body.push('')
    body.push(` ${statusGlyph(snapshot.panelStatuses.verify, theme)} ${color('Verify', theme.primary, { bold: true })}  ${snapshot.verification.deliveryStatus}  read:${snapshot.verification.filesRead} mod:${snapshot.verification.filesModified}`)
    for (const run of snapshot.verification.runs.slice(0, 3)) {
      body.push(`    ${run.tool}: ${run.summary} ${run.status}`)
    }
  }

  if (show('context') && snapshot.context) {
    body.push('')
    const ctx = snapshot.context
    const ratio = ctx.maxTokens > 0 ? ctx.estimatedTokens / ctx.maxTokens : 0
    const bar = formatBar(ctx.estimatedTokens, ctx.maxTokens, Math.min(w, 40), theme)
    body.push(` ${statusGlyph(snapshot.panelStatuses.context, theme)} ${color('Context', theme.primary, { bold: true })}  ${Math.round(ratio * 100)}%  ${ctx.estimatedTokens}/${ctx.maxTokens} tokens  rounds:${ctx.rounds}`)
    body.push(`    ${bar}`)
    if (ctx.brokenRounds > 0) {
      body.push(`    ${color(`⚠ ${ctx.brokenRounds} broken rounds`, theme.warning)}`)
    }
  }

  if (show('model')) {
    body.push('')
    const m = snapshot.model
    body.push(` ${statusGlyph(snapshot.panelStatuses.model, theme)} ${color('Model', theme.primary, { bold: true })}  ${m.name}  cache:${Math.round(m.cacheHitRate * 100)}%  ${m.inputTokens.toLocaleString()}↓ ${m.outputTokens.toLocaleString()}↑  ¥${m.cost.toFixed(4)}`)
    if (m.reasoningEffort) {
      body.push(`    reasoning: ${m.reasoningEffort}  prewarm: ${Math.round(m.prewarmHitRate * 100)}%`)
    }
    if (m.speculation) {
      const active = Object.entries(m.speculation).filter(([, s]) => s.enqueued > 0 || s.hits > 0)
      if (active.length > 0) {
        const parts = active.map(([source, s]) => `${source}:${s.hits}/${s.enqueued}`)
        body.push(`    投机预读 (hits/enqueued): ${parts.join('  ')}`)
      }
    }
    body.push(`    ✦ 星域: ${color(m.starDomain, theme.secondary)}`)
  }

  if (show('mcp') && snapshot.mcp.servers.length > 0) {
    body.push('')
    body.push(` ${statusGlyph(snapshot.panelStatuses.mcp, theme)} ${color('MCP', theme.primary, { bold: true })}  tools:${snapshot.mcp.totalTools}  connected:${snapshot.mcp.connectedServers}/${snapshot.mcp.servers.length}`)
    for (const srv of snapshot.mcp.servers.slice(0, 4)) {
      const g = srv.status === 'connected' ? color('✓', theme.success) : srv.status === 'error' ? color('✗', theme.error) : color('○', theme.warning)
      body.push(`    ${g} ${srv.serverId}  ${srv.toolCount} tools`)
    }
  }

  if (show('advisory') && (panel === 'advisory' || snapshot.advisory.rendered > 0 || snapshot.advisory.silenced.length > 0)) {
    body.push('')
    const adv = snapshot.advisory
    body.push(` ${statusGlyph(snapshot.panelStatuses.advisory, theme)} ${color('Advisory', theme.primary, { bold: true })}  rendered:${adv.rendered} dropped:${adv.dropped} adopted:${adv.adopted} ignored:${adv.ignored} heldOut:${adv.heldOut}${adv.pendingWatch > 0 ? `  pending:${adv.pendingWatch}` : ''}`)
    if (adv.silenced.length > 0) {
      const parts = adv.silenced.slice(0, 4).map(s => `${s.key}(${s.reason === 'lift' ? 'lift' : 'hab'}:${s.remaining})`)
      body.push(`    ${color(`⊘ 静音 ${parts.join(' ')}`, theme.warning)}`)
    }
    // 聚焦视图才展开 per-key 效能与 status 通道（summary 只给一行概览）
    if (panel === 'advisory') {
      for (const k of adv.keys) {
        const rate = k.adoptionRate !== null ? `${Math.round(k.adoptionRate * 100)}%` : '—'
        const lift = k.lift !== null ? (k.lift >= 0 ? `+${k.lift.toFixed(2)}` : k.lift.toFixed(2)) : '—'
        const streak = k.ignoredStreak > 0 ? color(` streak:${k.ignoredStreak}`, theme.warning) : ''
        body.push(`    ${k.key}  ${k.delivered}投 ${k.adopted}纳 ${k.ignored}忽  采纳:${rate} lift:${lift}${streak}`)
      }
      if (adv.statusNotices.length > 0) {
        body.push(`    ${color('status 通道:', theme.muted)}`)
        for (const notice of adv.statusNotices.slice(-5)) {
          body.push(`      ${color(notice.length > w - 8 ? notice.slice(0, w - 9) + '…' : notice, theme.dim)}`)
        }
      }
    }
  }

  if (show('trace') && snapshot.trace.events.length > 0) {
    body.push('')
    body.push(` ${statusGlyph(snapshot.panelStatuses.trace, theme)} ${color('Trace', theme.primary, { bold: true })}  ${snapshot.trace.totalEvents} events`)
    for (const evt of snapshot.trace.events.slice(-5)) {
      const g = evt.status === 'failed' ? color('✗', theme.error) : evt.status === 'completed' ? color('✓', theme.success) : color('·', theme.muted)
      body.push(`    ${g} t${evt.turn} ${evt.kind}/${evt.name} ${evt.durationMs}ms`)
    }
  }

  const footer = panel === 'summary'
    ? 'q 关闭   ·   /cockpit <面板> 聚焦'
    : `${PANEL_LABELS[panel]}   ·   /cockpit summary 看全部   ·   q 关闭`

  const lines: string[] = [
    frameTop(width, theme),
    frameTitle('⚙ 运行时仪表盘', width, theme),
  ]
  for (let i = 0; i < contentRows; i++) lines.push(frameLine(body[i] ?? '', width, theme))
  lines.push(frameFooter(footer, width, theme))
  lines.push(frameBottom(width, theme))
  return lines
}
