import { Box, Text } from 'ink'
import React, { useState, useEffect } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import { getTheme, type RivetTheme } from './theme.js'
import { useTerminalSize, isResizeSettling } from './use-terminal-size.js'
import type { GlancePulse } from './surface/types.js'
import { horizontalRule, type SeparatorStyle } from './separator.js'
import { STAR_DOMAINS } from '../agent/star-domain.js'
import { formatToolElapsed } from './tool-elapsed.js'

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
}

function findDomain(domainName: string | undefined) {
  if (!domainName) return undefined
  for (const [id, domain] of Object.entries(STAR_DOMAINS)) {
    if (domain.name === domainName || id === domainName) return domain
  }
  return undefined
}

function getDomainColor(domainName: string | undefined, theme: RivetTheme): string {
  // Per-domain qi: resolve uiPersona.accent (a theme color-key) through the
  // active theme so 天枢/天璇 read as distinct identities, while still adapting
  // to starfield/midnight. Paired with a per-domain glyph (see getDomainGlyph)
  // for a color+symbol dual channel — domains stay distinguishable even on
  // colorblind / low-contrast terminals (WCAG color-not-only).
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

export const GlanceBar = React.memo(function GlanceBar({ pulses, phase, cacheHitRate, cost, model, isStreaming, historyCount, domain, branch, estimatedTokens, maxTokens, elapsedMs }: GlanceBarProps) {
  const theme = getTheme()
  const [moonIdx, setMoonIdx] = useState(0)

  useEffect(() => {
    if (!isStreaming) return
    const interval = setInterval(() => {
      // Don't animate mid-resize: a commit now under-erases at an intermediate
      // width and stacks ghost copies of this bar (see use-terminal-size.ts).
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
  const domainGlyph = getDomainGlyph(domain)

  // ── Single-line cohesive status bar — │ separators, no spatial gaps ──
  const modelLabel = narrow ? model.slice(0, 12) : model.slice(0, 20)
  const elapsedLabel = elapsedMs !== undefined ? formatToolElapsed(elapsedMs) : ''

  // Full-width rule: pass columns as maxWidth to remove the 72-char cap
  const rule = horizontalRule(columns, getDomainSeparatorStyle(domain), columns)

  return (
    <Box flexDirection="column" marginTop={1}>
      {/* Full-width separator line */}
      <Text color={domainColor}>{rule}</Text>
      {/* Single cohesive status line: identity │ phase │ metrics ……… elapsed */}
      <Box flexDirection="row" width="100%">
        {/* Zone 1 · identity — star domain (bold + domain color) + branch.
            Idle (no worker domain active) = 天枢, the navigator/pivot star,
            in calm silver. Worker domains carry their own qi (color+glyph). */}
        {domain
          ? <Text bold color={domainColor}>{domainGlyph} {domain}</Text>
          : <Text bold color={theme.secondary}>❂ 天枢</Text>
        }
        {branchLabel && !narrow && <Text color={theme.secondary}> ⎇ {branchLabel}</Text>}

        <Text color={theme.secondary} bold>{'  ┃  '}</Text>

        {/* Zone 2 · phase + streaming indicator */}
        {phaseGlyph
          ? <Text bold color={hasActive ? theme.primary : theme.secondary}>{phaseGlyph} {phaseLabel}</Text>
          : <Text color={theme.secondary}>{phaseLabel || 'idle'}</Text>
        }
        {isStreaming && <Text color={theme.primary}> {MOON_PHASES[moonIdx]}</Text>}

        <Text color={theme.secondary} bold>{'  ┃  '}</Text>

        {/* Zone 3 · metrics — model (bold), cache, cost, tokens */}
        <Text bold color={theme.primary}>「{modelLabel}」</Text>
        <Text color={theme.dim}> </Text>
        <Text color={cacheColor}>⚡{cachePct}%</Text>
        <Text color={theme.dim}> · </Text>
        <Text color={theme.muted}>${cost.toFixed(2)}</Text>
        {!narrow && <Text color={theme.dim}> · </Text>}
        {!narrow && <Text color={tokenColor}>◧ {estimatedK}k/{maxK}k ({pct}%)</Text>}
        {narrow && <Text color={tokenColor}> · {pct}%</Text>}
        {ratio >= 0.78 && <Text color={theme.error}> compact</Text>}
        {historyCount !== undefined && !narrow && (
          <Text color={theme.muted}> · {historyCount} msgs</Text>
        )}
        {alertPulse?.hint && <Text color={theme.error}> · {alertPulse.hint}</Text>}

        {/* Flexible spacer pushes elapsed to the far right edge */}
        <Box flexGrow={1} />

        {/* Zone 4 · elapsed — flows live on the far right */}
        {elapsedLabel && (
          <Text color={isStreaming ? theme.primary : theme.dim}>⧗ {elapsedLabel}</Text>
        )}
      </Box>
    </Box>
  )
})
