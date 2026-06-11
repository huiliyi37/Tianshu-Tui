/**
 * T9 格式化函数 — 子代理 TeamPanel（团队协作面板）。
 *
 * 从 `team-panel.tsx` 的 `renderTeamPanelLines` 移植为框架无关的 ANSI 行渲染，
 * 仅依赖 `team-panel-model.js`（框架无关）与 ansi/theme，避免 T9 路径引入 React/Ink。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import { starFor, type TeamPanelModel, type TeamPanelStatus } from '../team-panel-model.js'

function statusGlyph(status: TeamPanelStatus): string {
  switch (status) {
    case 'done': return '✓'
    case 'running': return '◐'
    case 'blocked': return '⊗'
    case 'failed': return '✗'
    case 'waiting': return '◌'
  }
}

function riskMark(risk: 'low' | 'medium' | 'high'): string {
  if (risk === 'high') return 'high ⚠'
  if (risk === 'medium') return 'medium'
  return 'low'
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}…` : text
}

/** 生成 TeamPanel 的纯文本行（无颜色，便于宽度计算/测试）。 */
export function buildTeamPanelLines(model: TeamPanelModel, width = 80): string[] {
  const safeWidth = Math.max(48, width)
  const inner = safeWidth - 4
  const title = `团队协作 · /team ${model.mode}`
  const waveLabel = model.totalWaves > 0 ? `wave ${Math.min(model.currentWave + 1, model.totalWaves)}/${model.totalWaves}` : 'wave 0/0'
  const topFill = Math.max(1, inner - title.length - waveLabel.length - 2)
  const lines = [`╭─ ${title}${'─'.repeat(topFill)} ${waveLabel} ─╮`]
  const tasks = new Map(model.tasks.map(t => [t.id, t]))

  if (model.waves.length === 0) {
    lines.push(`│ ${truncate('team: no dispatchable waves.', inner).padEnd(inner)} │`)
  }

  for (const [index, wave] of model.waves.entries()) {
    const complete = wave.taskIds.every(id => tasks.get(id)?.status === 'done')
    const active = index === model.currentWave && !complete
    const waveGlyph = complete ? '✓' : active ? '◐' : '◌'
    lines.push(`│ ${truncate(`${wave.id} ${waveGlyph}  ${riskMark(wave.risk)}  ${wave.reason}`, inner).padEnd(inner)} │`)
    for (const id of wave.taskIds) {
      const task = tasks.get(id)
      if (!task) continue
      const star = starFor(task.authority)
      const identity = task.identity ?? { name: star.name, glyph: star.glyph }
      const head = `  ${identity.glyph} ${identity.name} ${task.id}`
      const status = `${statusGlyph(task.status)} ${task.status}`
      lines.push(`│ ${truncate(`${head.padEnd(16)} ${truncate(task.title, 34).padEnd(34)} ${status}`, inner).padEnd(inner)} │`)
      if (task.dependsOn.length > 0) {
        lines.push(`│ ${truncate(`      └─ depends ─ ${task.dependsOn.join(', ')}`, inner).padEnd(inner)} │`)
      }
      if (task.summary && task.status !== 'waiting') {
        lines.push(`│ ${truncate(`      · ${task.summary}`, inner).padEnd(inner)} │`)
      }
    }
  }

  if (model.blocked.length > 0) {
    lines.push(`│ ${truncate(`blocked: ${model.blocked.join('; ')}`, inner).padEnd(inner)} │`)
  }
  const gate = model.reviewVerdict ? `gate: ${model.reviewVerdict}` : 'gate: pending'
  const foot = `${model.dispatched} dispatched · ${model.blocked.length} blocked · ${gate}`
  lines.push(`╰─ ${truncate(foot, inner).padEnd(inner, '─')} ─╯`)
  return lines
}

/**
 * 渲染 TeamPanel 为带色 ANSI 行（与 Ink TeamPanel 同款每行配色规则）：
 *  high ⚠ → error · medium → warning · 首尾边框 → secondary · 其余 → primary。
 */
export function formatTeamPanel(model: TeamPanelModel, theme: RivetTheme, width = 80): string[] {
  const lines = buildTeamPanelLines(model, width)
  return lines.map((line, index) => {
    const c = line.includes('high ⚠') ? theme.error
      : line.includes('medium') ? theme.warning
      : index === 0 || index === lines.length - 1 ? theme.secondary
      : theme.primary
    return color(line, c)
  })
}
