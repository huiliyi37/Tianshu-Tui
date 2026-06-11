/**
 * T9 格式化函数 — 子代理 TeamPanel（团队协作面板）。
 *
 * 从 `team-panel.tsx` 的 `renderTeamPanelLines` 移植为框架无关的 ANSI 行渲染，
 * 仅依赖 `team-panel-model.js`（框架无关）与 ansi/theme，避免 T9 路径引入 React/Ink。
 */

import stringWidth from 'string-width'
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

/**
 * 生成 TeamPanel 的纯文本行（无颜色，便于宽度计算/测试）。
 *
 * v2 水墨布局：弃用 ╭─╮│╰╯ 粗框，改为「◇ 标题 … wave x/y」+ 极淡 hairline 分隔，
 * 缩进表达 wave→task→depends/summary 层级，靠留白而非框线分组。
 */
export function buildTeamPanelLines(model: TeamPanelModel, width = 80): string[] {
  const safeWidth = Math.max(48, width)
  const rule = Math.min(safeWidth, 72)
  const title = `◇ 团队协作 · /team ${model.mode}`
  const waveLabel = model.totalWaves > 0 ? `wave ${Math.min(model.currentWave + 1, model.totalWaves)}/${model.totalWaves}` : 'wave 0/0'
  // 标题行：◇ 标题 …留白… wave x/y（右对齐 waveLabel）
  const gap = Math.max(2, rule - stringWidth(title) - stringWidth(waveLabel))
  const lines = [`${title}${' '.repeat(gap)}${waveLabel}`]
  lines.push('─'.repeat(rule)) // 顶 hairline
  const tasks = new Map(model.tasks.map(t => [t.id, t]))

  if (model.waves.length === 0) {
    lines.push(truncate('team: no dispatchable waves.', rule))
  }

  for (const [index, wave] of model.waves.entries()) {
    const complete = wave.taskIds.every(id => tasks.get(id)?.status === 'done')
    const active = index === model.currentWave && !complete
    const waveGlyph = complete ? '✓' : active ? '◐' : '◌'
    lines.push(truncate(`${wave.id} ${waveGlyph}  ${riskMark(wave.risk)}  ${wave.reason}`, rule))
    for (const id of wave.taskIds) {
      const task = tasks.get(id)
      if (!task) continue
      const star = starFor(task.authority)
      const identity = task.identity ?? { name: star.name, glyph: star.glyph }
      const head = `  ${identity.glyph} ${identity.name} ${task.id}`
      const status = `${statusGlyph(task.status)} ${task.status}`
      lines.push(truncate(`${head.padEnd(16)} ${truncate(task.title, 34).padEnd(34)} ${status}`, rule))
      if (task.dependsOn.length > 0) {
        lines.push(truncate(`      └─ depends ─ ${task.dependsOn.join(', ')}`, rule))
      }
      if (task.summary && task.status !== 'waiting') {
        lines.push(truncate(`      · ${task.summary}`, rule))
      }
    }
  }

  if (model.blocked.length > 0) {
    lines.push(truncate(`blocked: ${model.blocked.join('; ')}`, rule))
  }
  lines.push('─'.repeat(rule)) // 底 hairline
  const gate = model.reviewVerdict ? `gate: ${model.reviewVerdict}` : 'gate: pending'
  lines.push(truncate(`${model.dispatched} dispatched · ${model.blocked.length} blocked · ${gate}`, rule))
  return lines
}

/**
 * 渲染 TeamPanel 为带色 ANSI 行（v2 水墨配色规则）：
 *  标题行 → primary(紫微) · hairline/footer → dim · high ⚠ → error · medium → warning ·
 *  running 任务行 → 唯一点亮 primary · 其余 → 中性默认前景(不着色，避免满屏色)。
 */
export function formatTeamPanel(model: TeamPanelModel, theme: RivetTheme, width = 80): string[] {
  const lines = buildTeamPanelLines(model, width)
  const lastIdx = lines.length - 1
  return lines.map((line, index) => {
    if (index === 0) return color(line, theme.primary, { bold: true }) // 标题行
    if (/^─+$/.test(line)) return color(line, theme.dim)                // hairline
    if (index === lastIdx) return color(line, theme.muted)             // footer 元信息
    if (line.includes('high ⚠')) return color(line, theme.error)
    if (line.includes('medium')) return color(line, theme.warning)
    if (line.includes('◐ running')) return color(line, theme.primary)  // 唯一点亮态
    return line // 中性默认前景 — 水墨留白
  })
}
