import React from 'react'
import { Box, Text } from 'ink'
import { getTheme } from './theme.js'
import { starFor, type TeamPanelModel, type TeamPanelStatus } from './team-panel-model.js'

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

export function renderTeamPanelLines(model: TeamPanelModel, width = 80): string[] {
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

export function TeamPanel({ model, width = 80 }: { model: TeamPanelModel; width?: number }) {
  const theme = getTheme()
  const lines = renderTeamPanelLines(model, width)
  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      {lines.map((line, index) => {
        const color = line.includes('high ⚠') ? theme.error
          : line.includes('medium') ? theme.warning
          : index === 0 || index === lines.length - 1 ? theme.secondary
          : theme.primary
        return <Text key={index} color={color}>{line}</Text>
      })}
    </Box>
  )
}
