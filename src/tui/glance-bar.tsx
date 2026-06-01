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
  historyCount?: number
  /** Active star domain name (e.g. 天枢) — identity marker */
  domain?: string
  /** Current git branch — identity marker */
  branch?: string
  /** Estimated tokens currently in the session context */
  estimatedTokens: number
  /** Model context window size in tokens */
  maxTokens: number
}

export const GlanceBar = memo(function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming, historyCount, domain, branch, estimatedTokens, maxTokens }: GlanceBarProps) {
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
  // Branch names can be long (e.g. feat/...); cap to keep GlanceBar single-line (flicker budget)
  const branchLabel = branch && branch.length > 24 ? branch.slice(0, 23) + '…' : branch

  const ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 0
  const estimatedK = Math.round(estimatedTokens / 1000)
  const maxK = Math.round(maxTokens / 1000)
  const pct = Math.round(ratio * 100)

  const tokenColor = ratio >= 0.88 ? theme.error
    : ratio >= 0.78 ? theme.warning
    : ratio >= 0.60 ? theme.warning
    : theme.success

  return (
    <Box paddingX={narrow ? 0 : 1}>
      {domain && <Text bold color={theme.primary}>☆ {domain}</Text>}
      {domain && branchLabel && !narrow && <Text color={theme.dim}> · </Text>}
      {branchLabel && !narrow && <Text color={theme.secondary}>⎇ {branchLabel}</Text>}
      {(domain || (branchLabel && !narrow)) && <Text color={theme.dim}> · </Text>}
      {phaseGlyph && <Text bold color={hasActive ? theme.primary : theme.secondary}>{phaseGlyph} {phaseLabel}</Text>}
      {!phaseGlyph && <Text color={theme.secondary}>{phaseLabel || 'idle'}</Text>}
      {isStreaming && <Text color={theme.primary}> ●</Text>}
      <Text color={theme.dim}>   ·   </Text>
      <Text color={cacheColor}>{cachePct}%</Text>
      <Text color={theme.dim}> · </Text>
      <Text color={theme.muted}>${cost.toFixed(2)}</Text>
      {!narrow && <Text color={theme.muted}> · {model.slice(0, 20)}</Text>}
      {!narrow && <Text color={theme.dim}> · </Text>}
      {!narrow && <Text color={tokenColor}>{estimatedK}k/{maxK}k ({pct}%)</Text>}
      {narrow && <Text color={tokenColor}> · {pct}%</Text>}
      {ratio >= 0.78 && <Text color={theme.error}> · compact</Text>}
      {historyCount !== undefined && !narrow && (
        <Text color={theme.muted}> · {historyCount} msgs</Text>
      )}
      {alertPulse?.hint && <Text color={theme.error}> · {alertPulse.hint}</Text>}
    </Box>
  )
})
