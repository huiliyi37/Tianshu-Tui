import { Box, Text } from 'ink'
import { useState, useEffect } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import { getTheme, type RivetTheme } from './theme.js'
import { useTerminalSize } from './use-terminal-size.js'
import type { GlancePulse } from './surface/types.js'
import { horizontalRule } from './separator.js'

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

function getDomainColor(domainName: string | undefined, theme: RivetTheme): string {
  if (!domainName) return theme.dim
  switch (domainName) {
    case '破军':
    case 'pojun':
      return theme.error
    case '天府':
    case 'tianfu':
      return theme.warning
    case '天梁':
    case 'tianliang':
      return theme.success
    case '天权':
    case 'tianquan':
      return theme.secondary
    case '天机':
    case 'tianji':
      return theme.primary
    case '天璇':
    case 'tianxuan':
      return theme.primary
    case '天枢':
    case 'tianshu':
      return theme.primary
    default:
      return theme.primary
  }
}

const MOON_PHASES = ['◐', '◑', '◒', '◓'] as const

export const GlanceBar = function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming, historyCount, domain, branch, estimatedTokens, maxTokens }: GlanceBarProps) {
  const theme = getTheme()
  const [moonIdx, setMoonIdx] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const interval = setInterval(() => setMoonIdx(i => (i + 1) % MOON_PHASES.length), 600)
    return () => clearInterval(interval)
  }, [isStreaming])
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

  const domainColor = getDomainColor(domain, theme)

  return (
    <Box flexDirection="column" marginTop={1}>
      <Box paddingX={narrow ? 0 : 1}>
        <Text color={domainColor}>{horizontalRule(columns, 'thin')}</Text>
      </Box>
      <Box paddingX={narrow ? 0 : 1} flexDirection="row">
        {domain && <Text bold color={domainColor}>☆ {domain}</Text>}
        {domain && branchLabel && !narrow && <Text color={theme.dim}> · </Text>}
        {branchLabel && !narrow && <Text color={theme.secondary}>⎇ {branchLabel}</Text>}
        {(domain || (branchLabel && !narrow)) && <Text color={theme.dim}> │ </Text>}
        {phaseGlyph && <Text bold color={hasActive ? theme.primary : theme.secondary}>{phaseGlyph} {phaseLabel}</Text>}
        {!phaseGlyph && <Text color={theme.secondary}>{phaseLabel || 'idle'}</Text>}
        {isStreaming && <Text color={theme.primary}> {MOON_PHASES[moonIdx]}</Text>}
        <Text color={theme.dim}> │ </Text>
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
    </Box>
  )
}
