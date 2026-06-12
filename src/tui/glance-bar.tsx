import { Box, Text } from 'ink'
import React, { useState, useEffect } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import type { ReasoningEffort } from '../agent/auto-reasoning.js'
import { getTheme, type RivetTheme } from './theme.js'
import { useTerminalSize, isResizeSettling } from './use-terminal-size.js'
import type { GlancePulse } from './surface/types.js'
import { horizontalRule, type SeparatorStyle } from './separator.js'
import { STAR_DOMAINS } from '../agent/star-domain.js'
import { formatToolElapsed } from './tool-elapsed.js'

const EFFORT_GLYPH: Record<ReasoningEffort, string> = {
  off: '○',
  low: '◔',
  medium: '◑',
  high: '◕',
  max: '●',
}

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
  /** Live elapsed time of the current/last turn (ms) — flows on the far right */
  elapsedMs?: number
  /** Current reasoning effort level */
  reasoningEffort?: ReasoningEffort
}

function findDomain(domainName: string | undefined) {
  if (!domainName) return undefined
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) return domain
  }
  return undefined
}

function getDomainColor(domainName: string | undefined, theme: RivetTheme): string {
  const domain = findDomain(domainName)
  if (!domain) return theme.dim
  return theme[domain.uiPersona.accent]
}

/** Per-domain star glyph (the symbol half of the dual channel). */
function getDomainGlyph(domainName: string | undefined): string {
  return findDomain(domainName)?.uiPersona.glyph ?? '☆'
}


export function getDomainSeparatorStyle(domainName: string | undefined): SeparatorStyle {
  if (!domainName) return 'thin'
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) {
      return domain.uiPersona.separator
    }
  }
  if (domainName === '天枢' || domainName === 'tianshu') return 'thin'
  return 'thin'
}
const MOON_PHASES = ['◐', '◑', '◒', '◓'] as const

/**
 * GlanceBar — 玄夜墨色 status strip.
 * Design: 95% 墨灰 (dim/muted), 紫微紫 (primary) reserved for the ONE active
 * element — the five-element phase glyph. No gold, no large color blocks.
 */
export const GlanceBar = React.memo(function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming, historyCount, domain, branch, estimatedTokens, maxTokens, elapsedMs, reasoningEffort }: GlanceBarProps) {
  const theme = getTheme()
  const [moonIdx, setMoonIdx] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const interval = setInterval(() => {
      if (isResizeSettling()) return
      setMoonIdx(i => (i + 1) % MOON_PHASES.length)
    }, 600)
    return () => clearInterval(interval)
  }, [isStreaming])
  const { columns } = useTerminalSize()
  const phaseGlyph = PHASE_GLYPHS[phase] ?? ''
  const phaseLabel = PHASE_SHORT_LABELS[phase] ?? ''
  const cachePct = Math.round(cacheHitRate * 100)
  const cacheColor = cacheHitRate >= 0.7 ? theme.success : cacheHitRate >= 0.5 ? theme.warning : theme.dim
  const alertPulse = pulses.find(p => p.level === 'alert')
  const hasActive = pulses.some(p => p.level === 'active')

  const narrow = columns < 60
  const branchLabel = branch && branch.length > 24 ? branch.slice(0, 23) + '…' : branch

  const ratio = maxTokens > 0 ? estimatedTokens / maxTokens : 0
  const estimatedK = Math.round(estimatedTokens / 1000)
  const maxK = Math.round(maxTokens / 1000)
  const pct = Math.round(ratio * 100)

  const tokenColor = ratio >= 0.88 ? theme.error
    : ratio >= 0.75 ? theme.warning
    : theme.dim

  const domainColor = getDomainColor(domain, theme)
  const domainGlyph = getDomainGlyph(domain)

  const modelLabel = narrow ? model.slice(0, 12) : model.slice(0, 20)
  const elapsedLabel = elapsedMs !== undefined ? formatToolElapsed(elapsedMs) : ''

  const rule = horizontalRule(columns, getDomainSeparatorStyle(domain), columns)

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Full-width separator line — dim, barely visible */}
      <Text color={theme.dim}>{rule}</Text>
      {/* Single cohesive status line: identity · phase · metrics ……… elapsed */}
      <Box flexDirection="row" width="100%">
        {/* Zone 1 · identity — muted, not gold/purple. 95% 墨灰. */}
        <Text color={theme.muted}>{domainGlyph} {domain ?? '天枢'}</Text>
        {branchLabel && !narrow && <Text color={theme.dim}> ⎇ {branchLabel}</Text>}

        {/* Zone separator — dim dot, NOT bold purple */}
        <Text color={theme.dim}>  ·  </Text>

        {/* Zone 2 · phase — 五行 glyph in ziwei (primary), label in muted.
            This is the ONE accent point in the entire status bar. */}
        {phaseGlyph
          ? <Text color={theme.primary}>{phaseGlyph} </Text>
          : null}
        <Text color={theme.muted}>{phaseLabel || 'idle'}</Text>
        {isStreaming && <Text color={theme.primary}> {MOON_PHASES[moonIdx]}</Text>}

        <Text color={theme.dim}>  ·  </Text>

        {/* Zone 3 · metrics — all muted/dim, dot-separated */}
        <Text color={theme.muted}>{modelLabel}</Text>
        {reasoningEffort && <Text color={theme.dim}> · {EFFORT_GLYPH[reasoningEffort]}{reasoningEffort}</Text>}
        <Text color={cacheColor}> ⚡{cachePct}%</Text>
        <Text color={theme.dim}> · ${cost.toFixed(2)}</Text>
        {!narrow && <Text color={tokenColor}> · ◧ {estimatedK}k/{maxK}k ({pct}%)</Text>}
        {narrow && <Text color={tokenColor}> · {pct}%</Text>}
        {ratio >= 0.78 && <Text color={theme.error}> compact</Text>}
        {historyCount !== undefined && !narrow && (
          <Text color={theme.dim}> · {historyCount} msgs</Text>
        )}
        {alertPulse?.hint && <Text color={theme.error}> · {alertPulse.hint}</Text>}

        {/* Flexible spacer pushes elapsed to the far right edge */}
        <Box flexGrow={1} />

        {/* Zone 4 · elapsed — ziwei when streaming, dim when idle */}
        {elapsedLabel && (
          <Text color={isStreaming ? theme.primary : theme.dim}>⧗ {elapsedLabel}</Text>
        )}
      </Box>
    </Box>
  )
})
