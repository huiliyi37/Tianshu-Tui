import { Box, Text } from 'ink'
import { memo } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import { getTheme } from './theme.js'
import type { GlancePulse } from './surface/types.js'

interface GlanceBarProps {
  pulses: readonly GlancePulse[]
  phase: StarPhase
  cacheHitRate: number
  cost: number
  model: string
  isStreaming: boolean
}

function pulseColor(level: GlancePulse['level'], theme: ReturnType<typeof getTheme>): string {
  if (level === 'alert') return theme.pulseAlert
  if (level === 'active') return theme.pulseActive
  return theme.pulseQuiet
}

function pulseChar(level: GlancePulse['level']): string {
  if (level === 'alert') return '●'
  if (level === 'active') return '◉'
  return '○'
}

export const GlanceBar = memo(function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming }: GlanceBarProps) {
  const theme = getTheme()
  const phaseGlyph = PHASE_GLYPHS[phase] ?? '·'
  const phaseLabel = PHASE_SHORT_LABELS[phase] ?? ''
  const cachePct = Math.round(cacheHitRate * 100)
  const cacheColor = cacheHitRate >= 0.7 ? theme.success : cacheHitRate >= 0.4 ? theme.warning : theme.dim
  const alertPulse = pulses.find(p => p.level === 'alert')

  return (
    <Box paddingX={1} borderStyle="round" borderColor={theme.dim}>
      <Text color={theme.dim}>{model.slice(0, 12)} </Text>
      {pulses.map(p => (
        <Text key={p.domain} color={pulseColor(p.level, theme)}>{pulseChar(p.level)}</Text>
      ))}
      <Text color={theme.dim}> {phaseGlyph}{phaseLabel} </Text>
      <Text color={cacheColor}>⚡{cachePct}%</Text>
      <Text color={theme.dim}> ¥{cost.toFixed(2)}</Text>
      {isStreaming && <Text color={theme.pulseActive}> ⟳</Text>}
      {alertPulse?.hint && <Text color={theme.pulseAlert}> ⚠ {alertPulse.hint}</Text>}
    </Box>
  )
})
