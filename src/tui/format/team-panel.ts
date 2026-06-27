/**
 * T9 格式化函数 — 子代理 TeamPanel（团队协作面板）。
 *
 * 从 `team-panel.tsx` 的 `renderTeamPanelLines` 移植为框架无关的 ANSI 行渲染，
 * 仅依赖 `team-panel-model.js`（框架无关）与 ansi/theme，避免 T9 路径引入 React/Ink。
 */

import { color } from '../engine/ansi.js'
import type { RivetTheme } from '../theme.js'
import type { TeamPanelModel, TeamPanelStatus } from '../team-panel-model.js'

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

function formatElapsed(ms: number): string {
  if (ms >= 60_000) return `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`
  if (ms >= 1000) return `${(ms / 1000).toFixed(ms >= 10_000 ? 0 : 1)}s`
  return `${ms}ms`
}

/** Per-wave compact progress bar (8 segments). */
function waveProgressBar(done: number, total: number): string {
  const ratio = total > 0 ? Math.min(1, done / total) : 0
  const filled = Math.round(ratio * 8)
  return `[${'█'.repeat(filled)}${'░'.repeat(Math.max(0, 8 - filled))}] ${done}/${total}`
}
function progressBar(done: number, total: number, segments = 12): string {
  const ratio = total > 0 ? Math.min(1, done / total) : 0
  const filled = Math.round(ratio * segments)
  return `  [${'█'.repeat(filled)}${'░'.repeat(Math.max(0, segments - filled))}] ${done}/${total} done`
}

/**
 * 生成 TeamPanel 的纯文本行（无颜色，便于宽度计算/测试）。
 *
 * v3 极简布局：无边框无分隔线，靠缩进表达 wave→task→depends/summary 层级。
 */
export function buildTeamPanelLines(model: TeamPanelModel, width = 80): string[] {
  const rule = Math.min(Math.max(48, width), 72)
  const title = `Team · /team ${model.mode}`
  const waveLabel = model.totalWaves > 0 ? `wave ${Math.min(model.currentWave + 1, model.totalWaves)}/${model.totalWaves}` : ''
  const lines = [waveLabel ? `${title}  ${waveLabel}` : title]
  const tasks = new Map(model.tasks.map(t => [t.id, t]))

  if (model.waves.length === 0) {
    lines.push('  no dispatchable waves.')
  }

  for (const [index, wave] of model.waves.entries()) {
    const complete = wave.taskIds.every(id => tasks.get(id)?.status === 'done')
    const active = index === model.currentWave && !complete
    const waveGlyph = complete ? '✓' : active ? '◐' : '◌'
    lines.push(truncate(`  ${wave.id} ${waveGlyph}  ${riskMark(wave.risk)}  ${wave.reason}`, rule))
    // Per-wave progress bar: shows done/total for this wave's tasks.
    const waveTaskIds = wave.taskIds
    const waveDone = waveTaskIds.filter(id => tasks.get(id)?.status === 'done').length
    const waveTotal = waveTaskIds.length
    lines.push(truncate(`    ${waveProgressBar(waveDone, waveTotal)}`, rule))
    for (const id of wave.taskIds) {
      const task = tasks.get(id)
      if (!task) continue
      const status = `${statusGlyph(task.status)} ${task.status}`
      // CC 极简：任务行以 id+title+status 为主；星域 identity 降级为可选尾注
      // （仅显式 task.identity 时弱化展示，默认不再注入 authority→星君 persona）。
      const idTag = task.identity ? `  ${task.identity.name}` : ''
      lines.push(truncate(`    ${task.id}  ${task.title}  ${status}${idTag}`, rule))
      if (task.dependsOn.length > 0) {
        lines.push(truncate(`      depends: ${task.dependsOn.join(', ')}`, rule))
      }
      // Live overlay row: elapsed + latest activity (P5), shown while running/ready.
      const liveMeta: string[] = []
      if (typeof task.elapsedMs === 'number' && task.status !== 'waiting') liveMeta.push(formatElapsed(task.elapsedMs))
      if (task.activity) liveMeta.push(task.activity)
      if (liveMeta.length > 0) {
        lines.push(truncate(`      ${liveMeta.join(' · ')}`, rule))
      }
      if (task.summary && task.status !== 'waiting') {
        lines.push(truncate(`      ${task.summary}`, rule))
      }
    }
  }

  if (model.tasks.length > 0) {
    const doneCount = model.tasks.filter(t => t.status === 'done').length
    lines.push(progressBar(doneCount, model.tasks.length))
  }
  if (model.blocked.length > 0) {
    lines.push(truncate(`  blocked: ${model.blocked.join('; ')}`, rule))
  }
  const gate = model.reviewVerdict ? `gate: ${model.reviewVerdict}` : 'gate: pending'
  lines.push(`${model.dispatched} dispatched · ${model.blocked.length} blocked · ${gate}`)
  return lines
}

/**
 * 渲染 TeamPanel 为带色 ANSI 行：
 *  标题行 → muted · high ⚠ → error · medium → warning ·
 *  running 任务行 → primary · footer → muted · 其余 → 默认前景。
 */
export function formatTeamPanel(model: TeamPanelModel, theme: RivetTheme, width = 80): string[] {
  const lines = buildTeamPanelLines(model, width)
  const lastIdx = lines.length - 1
  return lines.map((line, index) => {
    if (index === 0) return color(line, theme.muted)
    if (index === lastIdx) return color(line, theme.muted)
    if (line.includes('high ⚠')) return color(line, theme.error)
    if (line.includes('medium')) return color(line, theme.warning)
    if (line.includes('◐ running')) return color(line, theme.primary)
    return line
  })
}
