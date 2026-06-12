/**
 * T9 Cockpit overlay — ANSI 渲染器。
 *
 * 消费 buildCockpitSnapshot() 的 CockpitSnapshot 数据，
 * 渲染纯 ANSI 仪表盘 overlay。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { CockpitSnapshot, PanelStatus } from '../cockpit/types.js'

function statusGlyph(s: PanelStatus): string {
  switch (s) {
    case 'ok': return color('✓', '#34d399')
    case 'warn': return color('⚠', '#fbbf24')
    case 'error': return color('✗', '#f87171')
    case 'idle': return color('○', '#6b7280')
    default: return '?'
  }
}

function formatBar(value: number, max: number, width: number, okColor: string, warnColor: string, errColor: string): string {
  const ratio = Math.min(1, Math.max(0, value / max))
  const filled = Math.round(ratio * width)
  const empty = width - filled
  const barColor = ratio > 0.9 ? errColor : ratio > 0.7 ? warnColor : okColor
  return color('█'.repeat(filled), barColor) + color('░'.repeat(empty), '#374151')
}

export function renderCockpit(snapshot: CockpitSnapshot, width: number, height: number, theme: RivetTheme): string[] {
  const lines: string[] = []
  const w = width - 4 // inner content width

  // Title
  lines.push('')
  lines.push(`  ${color('⚙  Cockpit', theme.primary, { bold: true })}  ${color('— 运行时仪表盘', theme.dim)}`)

  // Safety panel
  lines.push('')
  lines.push(`  ${statusGlyph(snapshot.panelStatuses.safety)} ${color('Safety', theme.primary, { bold: true })}  ${color(snapshot.safety.riskLevel, theme.muted)}  doom:${snapshot.safety.doomLoopLevel}`)
  if (snapshot.safety.suggestedAction) {
    lines.push(`    ${color(snapshot.safety.suggestedAction, theme.muted)}`)
  }

  // Verification panel
  lines.push('')
  lines.push(`  ${statusGlyph(snapshot.panelStatuses.verify)} ${color('Verify', theme.primary, { bold: true })}  ${snapshot.verification.deliveryStatus}  read:${snapshot.verification.filesRead} mod:${snapshot.verification.filesModified}`)
  for (const run of snapshot.verification.runs.slice(0, 3)) {
    lines.push(`    ${run.tool}: ${run.summary} ${run.status}`)
  }

  // Context panel
  if (snapshot.context) {
    lines.push('')
    const ctx = snapshot.context
    const ratio = ctx.maxTokens > 0 ? ctx.estimatedTokens / ctx.maxTokens : 0
    const bar = formatBar(ctx.estimatedTokens, ctx.maxTokens, Math.min(w, 40), '#34d399', '#fbbf24', '#f87171')
    lines.push(`  ${statusGlyph(snapshot.panelStatuses.context)} ${color('Context', theme.primary, { bold: true })}  ${Math.round(ratio * 100)}%  ${ctx.estimatedTokens}/${ctx.maxTokens} tokens  rounds:${ctx.rounds}`)
    lines.push(`    ${bar}`)
    if (ctx.brokenRounds > 0) {
      lines.push(`    ${color(`⚠ ${ctx.brokenRounds} broken rounds`, '#fbbf24')}`)
    }
  }

  // Model panel
  lines.push('')
  const m = snapshot.model
  lines.push(`  ${statusGlyph(snapshot.panelStatuses.model)} ${color('Model', theme.primary, { bold: true })}  ${m.name}  cache:${Math.round(m.cacheHitRate * 100)}%  ${m.inputTokens.toLocaleString()}↓ ${m.outputTokens.toLocaleString()}↑  $${m.cost.toFixed(4)}`)
  if (m.reasoningEffort) {
    lines.push(`    reasoning: ${m.reasoningEffort}  prewarm: ${Math.round(m.prewarmHitRate * 100)}%`)
  }

  // MCP panel
  if (snapshot.mcp.servers.length > 0) {
    lines.push('')
    lines.push(`  ${statusGlyph(snapshot.panelStatuses.mcp)} ${color('MCP', theme.primary, { bold: true })}  tools:${snapshot.mcp.totalTools}  connected:${snapshot.mcp.connectedServers}/${snapshot.mcp.servers.length}`)
    for (const srv of snapshot.mcp.servers.slice(0, 4)) {
      const g = srv.status === 'connected' ? color('✓', '#34d399') : srv.status === 'error' ? color('✗', '#f87171') : color('○', '#fbbf24')
      lines.push(`    ${g} ${srv.serverId}  ${srv.toolCount} tools`)
    }
  }

  // Trace panel — recent events
  if (snapshot.trace.events.length > 0) {
    lines.push('')
    lines.push(`  ${statusGlyph(snapshot.panelStatuses.trace)} ${color('Trace', theme.primary, { bold: true })}  ${snapshot.trace.totalEvents} events`)
    for (const evt of snapshot.trace.events.slice(-5)) {
      const g = evt.status === 'failed' ? color('✗', '#f87171') : evt.status === 'completed' ? color('✓', '#34d399') : color('·', theme.muted)
      lines.push(`    ${g} t${evt.turn} ${evt.kind}/${evt.name} ${evt.durationMs}ms`)
    }
  }

  // Pad remaining
  const usedLines = lines.length
  const maxHeight = height - 2
  for (let i = usedLines; i < maxHeight; i++) {
    lines.push('')
  }

  lines.push(`  ${color('q to close', theme.dim)}`)

  return lines
}
