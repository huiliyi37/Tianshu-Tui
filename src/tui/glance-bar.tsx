import { Box, Text } from 'ink'
import React, { useState, useEffect } from 'react'
import type { StarPhase } from '../agent/star-event.js'
import { PHASE_GLYPHS, PHASE_SHORT_LABELS } from '../agent/star-event.js'
import type { ReasoningEffort } from '../agent/auto-reasoning.js'
import { getTheme, type RivetTheme } from './theme.js'
import { useTerminalSize, isResizeSettling } from './use-terminal-size.js'
import type { GlancePulse } from './surface/types.js'
import type { SeparatorStyle } from './separator.js'
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
  /** 缓存命中率 0-1；undefined 表示尚无数据（不渲染 ⚡） */
  cacheHitRate?: number
  cost: number
  model: string
  isStreaming: boolean
  historyCount?: number
  /** Active star domain name (e.g. 天枢) — identity marker */
  domain?: string
  /** Current git branch — identity marker */
  branch?: string
  /** 估算已用 token；undefined 表示尚无数据（不渲染 ◧） */
  estimatedTokens?: number
  /** 模型上下文窗口大小；undefined 表示尚无数据（不渲染 ◧） */
  maxTokens?: number
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
  const cachePct = cacheHitRate !== undefined ? Math.round(cacheHitRate * 100) : 0
  const cacheColor = (cacheHitRate ?? 0) >= 0.7 ? theme.success : (cacheHitRate ?? 0) >= 0.5 ? theme.warning : theme.dim
  const alertPulse = pulses.find(p => p.level === 'alert')
  const hasActive = pulses.some(p => p.level === 'active')

  const narrow = columns < 60
  const branchLabel = branch && branch.length > 24 ? branch.slice(0, 23) + '…' : branch

  const ratio = (estimatedTokens !== undefined && maxTokens !== undefined && maxTokens > 0) ? estimatedTokens / maxTokens : 0
  const estimatedK = estimatedTokens !== undefined ? Math.round(estimatedTokens / 1000) : 0
  const maxK = maxTokens !== undefined ? Math.round(maxTokens / 1000) : 0
  const tokenColor = ratio >= 0.88 ? theme.error
    : ratio >= 0.75 ? theme.warning
    : theme.dim

  const domainColor = getDomainColor(domain, theme)
  const domainGlyph = getDomainGlyph(domain)

  const modelLabel = narrow ? model.slice(0, 12) : model.slice(0, 20)
  const elapsedLabel = elapsedMs !== undefined ? formatToolElapsed(elapsedMs) : ''

  return (
    <Box flexDirection="row" width="100%" marginTop={1}>
      {/* Left cluster — identity + phase */}
      <Box flexDirection="row">
        <Text color={domain ? domainColor : theme.muted}>{domainGlyph} {domain ?? '天枢'}</Text>
        {branchLabel && !narrow && <Text color={theme.dim}> · {branchLabel}</Text>}
        {phaseGlyph && <Text color={theme.primary}> {phaseGlyph}</Text>}
        {phaseLabel && <Text color={theme.muted}> {phaseLabel}</Text>}
        {isStreaming && <Text color={theme.primary}> {MOON_PHASES[moonIdx]}</Text>}
      </Box>

      {/* Flexible spacer */}
      <Box flexGrow={1} />

      {/* Right cluster — minimal: model + cost + elapsed; anomaly-only: cache/token */}
      <Box flexDirection="row" gap={1}>
        <Text color={theme.dim}>{modelLabel}</Text>
        {cacheHitRate !== undefined && cacheHitRate < 0.5 && <Text color={cacheColor}>⚡{cachePct}%</Text>}
        {estimatedTokens !== undefined && maxTokens !== undefined && maxTokens > 0 && ratio >= 0.75 && (
          <Text color={tokenColor}>◧{estimatedK}k/{maxK}k</Text>
        )}
        {cost > 0 && <Text color={theme.dim}>${cost.toFixed(2)}</Text>}
        {elapsedLabel && isStreaming && (
          <Text color={theme.dim}>{elapsedLabel}</Text>
        )}
      </Box>
    </Box>
  )
})
