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
  const inner = Math.max(44, width - 6)
  const waveLabel = model.totalWaves > 0 ? `wave ${Math.min(model.currentWave + 1, model.totalWaves)}/${model.totalWaves}` : ''
  const lines = [`  团队 · /team ${model.mode}${waveLabel ? '  ' + waveLabel : ''}`]
  const tasks = new Map(model.tasks.map(t => [t.id, t]))

  if (model.waves.length === 0) {
    lines.push('    no dispatchable waves.')
  }

  for (const [index, wave] of model.waves.entries()) {
    const complete = wave.taskIds.every(id => tasks.get(id)?.status === 'done')
    const active = index === model.currentWave && !complete
    const waveGlyph = complete ? '✓' : active ? '◐' : '◌'
    lines.push(`    ${wave.id} ${waveGlyph}  ${riskMark(wave.risk)}  ${wave.reason}`)
    for (const id of wave.taskIds) {
      const task = tasks.get(id)
      if (!task) continue
      const star = starFor(task.authority)
      const identity = task.identity ?? { name: star.name, glyph: star.glyph }
      const status = `${statusGlyph(task.status)} ${task.status}`
      lines.push(truncate(`      ${identity.glyph} ${identity.name} ${task.id}  ${task.title}  ${status}`, inner))
      if (task.dependsOn.length > 0) {
        lines.push(truncate(`        depends: ${task.dependsOn.join(', ')}`, inner))
      }
      if (task.summary && task.status !== 'waiting') {
        lines.push(truncate(`        ${task.summary}`, inner))
      }
    }
  }

  if (model.blocked.length > 0) {
    lines.push(`    blocked: ${truncate(model.blocked.join('; '), inner)}`)
  }
  const gate = model.reviewVerdict ? `gate: ${model.reviewVerdict}` : 'gate: pending'
  lines.push(`  ${model.dispatched} dispatched · ${model.blocked.length} blocked · ${gate}`)
  return lines
}

export function TeamPanel({ model, width = 80 }: { model: TeamPanelModel; width?: number }) {
  const theme = getTheme()
  const lines = renderTeamPanelLines(model, width)
  return (
    <Box flexDirection="column" paddingX={1}>
      {lines.map((line, index) => {
        const color = line.includes('high ⚠') ? theme.error
          : line.includes('medium') ? theme.warning
          : index === 0 || index === lines.length - 1 ? theme.muted
          : theme.dim
        return <Text key={index} color={color}>{line}</Text>
      })}
    </Box>
  )
}
