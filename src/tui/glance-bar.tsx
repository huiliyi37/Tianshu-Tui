import { Box, Text } from 'ink'
import { memo } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import { getTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'
import type { GlancePulse } from './surface/types.js'

interface GlanceBarProps {
  pulses: readonly GlancePulse[]
  phase: StarPhase
  cacheHitRate: number
  cost: number
  model: string
  isStreaming: boolean
}

export const GlanceBar = memo(function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming }: GlanceBarProps) {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  const phaseGlyph = PHASE_GLYPHS[phase] ?? ''
  const phaseLabel = PHASE_SHORT_LABELS[phase] ?? ''
  const cachePct = Math.round(cacheHitRate * 100)
  const cacheColor = cacheHitRate >= 0.7 ? theme.success : cacheHitRate >= 0.5 ? theme.warning : theme.dim
  const alertPulse = pulses.find(p => p.level === 'alert')
  const hasActive = pulses.some(p => p.level === 'active')

  // Adaptive layout: narrow terminal → compact mode
  const narrow = columns < 60

  return (
    <Box paddingX={narrow ? 0 : 1}>
      {!narrow && <Text color={theme.dim}>{model.slice(0, 20)}</Text>}
      {!narrow && <Text color={theme.dim}> · </Text>}
      {phaseGlyph && <Text color={hasActive ? theme.primary : theme.secondary}>{phaseGlyph} {phaseLabel}</Text>}
      {!phaseGlyph && <Text color={theme.secondary}>{phaseLabel || 'idle'}</Text>}
      <Text color={theme.dim}> · </Text>
      <Text color={cacheColor}>{cachePct}%</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.dim}>${cost.toFixed(2)}</Text>
      {isStreaming && <Text color={theme.primary}> ●</Text>}
      {alertPulse?.hint && <Text color={theme.error}> {alertPulse.hint}</Text>}
    </Box>
  )
})
