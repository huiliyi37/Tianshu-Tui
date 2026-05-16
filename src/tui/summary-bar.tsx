import { Box, Text } from 'ink'
import { memo } from 'react'
import type { Phase, LastAction } from './phase-tracker.js'
import { getTheme } from './theme.js'

export interface SummaryState {
  task: string
  phase: Phase
  stepCount: number
  totalSteps: number
  contextPct: number
  elapsedMs: number
  lastAction: LastAction | null
  risk: 'none' | 'medium' | 'high'
  compactEvent?: { beforeTokens: number; afterTokens: number } | null
  approvalNeeded?: { tool: string; target: string } | null
  tokenHistory?: number[]  // last N context percentages (0-1)
}

function truncate(s: string, max: number): string {
  return s.length > max ? s.slice(0, max - 1) + '…' : s
}

export function formatElapsed(ms: number): string {
  const sec = Math.round(ms / 1000)
  if (sec < 60) return `${sec}s`
  const m = Math.floor(sec / 60)
  const s = sec % 60
  return `${m}m${s > 0 ? `${s}s` : ''}`
}

// Braille sparkline: renders values 0-1 as braille dot columns
// Each braille char encodes a 2-wide x 4-tall dot grid
export function brailleSparkline(values: number[]): string {
  if (values.length === 0) return ''

  const BRAILLE_BASE = 0x2800
  const leftDots = [0, 1, 2, 6]
  const rightDots = [3, 4, 5, 7]

  const chars: string[] = []
  for (let i = 0; i < values.length; i += 2) {
    let pattern = 0
    const lv = Math.max(0, Math.min(1, values[i] ?? 0))
    const lLevel = Math.round(lv * 3)
    for (let d = 0; d <= lLevel; d++) {
      pattern |= 1 << leftDots[d]!
    }
    const rv = Math.max(0, Math.min(1, values[i + 1] ?? values[i] ?? 0))
    const rLevel = Math.round(rv * 3)
    for (let d = 0; d <= rLevel; d++) {
      pattern |= 1 << rightDots[d]!
    }
    chars.push(String.fromCodePoint(BRAILLE_BASE + pattern))
  }
  return chars.join('')
}

export function contextBar(pct: number, width = 5): string {
  const filled = Math.round(pct * width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export function formatSummaryLine1(state: SummaryState): string {
  const task = truncate(state.task || 'working', 30)
  const phase = state.phase
  const steps = state.totalSteps > 0 ? ` (${state.stepCount}/${state.totalSteps})` : ''
  const pct = Math.round(state.contextPct * 100)
  const elapsed = formatElapsed(state.elapsedMs)
  return `◆ ${task} → ${phase}${steps} │ ${contextBar(state.contextPct)} ${pct}% │ ${elapsed}`
}

export function formatSummaryLine2(state: SummaryState): string {
  if (!state.lastAction) return '├ waiting for first action...'
  const icon = state.lastAction.success ? '✓' : '✗'
  const target = truncate(state.lastAction.target.split('/').pop() ?? state.lastAction.target, 30)
  return `├ last: ${state.lastAction.tool} ${target} → ${icon}`
}

export function formatSummaryLine3(state: SummaryState): string {
  if (state.approvalNeeded) return `└ ⚠ APPROVAL: ${state.approvalNeeded.tool} ${truncate(state.approvalNeeded.target, 25)}`
  if (state.compactEvent) {
    const before = Math.round(state.compactEvent.beforeTokens / 1000)
    const after = Math.round(state.compactEvent.afterTokens / 1000)
    return `└ ⚡ compact: ${before}k→${after}k`
  }
  return `└ step ${state.stepCount} │ risk: ${state.risk}`
}

export const SummaryBar = memo(function SummaryBar({ state }: { state: SummaryState }) {
  const theme = getTheme()
  const ctxColor = theme.contextColor(state.contextPct)
  const riskColor = state.risk === 'high' ? theme.error : state.risk === 'medium' ? theme.warning : theme.dim

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.primary}>◆ </Text>
        <Text bold>{truncate(state.task || 'working', 30)}</Text>
        <Text color={theme.dim}> → </Text>
        <Text color={theme.primary}>{state.phase}</Text>
        {state.totalSteps > 0 && <Text dimColor> ({state.stepCount}/{state.totalSteps})</Text>}
        <Text color={theme.dim}> │ </Text>
        <Text color={ctxColor} bold={state.contextPct >= 0.95}>{contextBar(state.contextPct)} {Math.round(state.contextPct * 100)}%</Text>
{state.tokenHistory && state.tokenHistory.length > 1 && (
  <Text color={theme.dim}> {brailleSparkline(state.tokenHistory)}</Text>
)}
        <Text color={theme.dim}> │ </Text>
        <Text dimColor>{formatElapsed(state.elapsedMs)}</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>├ </Text>
        {state.lastAction ? (
          <>
            <Text dimColor>last: </Text>
            <Text>{state.lastAction.tool} {truncate(state.lastAction.target.split('/').pop() ?? '', 30)}</Text>
            <Text color={state.lastAction.success ? theme.success : theme.error}> → {state.lastAction.success ? '✓' : '✗'}</Text>
          </>
        ) : (
          <Text dimColor>waiting for first action...</Text>
        )}
      </Text>
      <Text>
        <Text color={theme.dim}>└ </Text>
        {state.approvalNeeded ? (
          <Text bold color={theme.error}>⚠ APPROVAL: {state.approvalNeeded.tool} {truncate(state.approvalNeeded.target, 25)}</Text>
        ) : state.compactEvent ? (
          <Text color={theme.warning}>⚡ compact: {Math.round(state.compactEvent.beforeTokens / 1000)}k→{Math.round(state.compactEvent.afterTokens / 1000)}k</Text>
        ) : (
          <>
            <Text dimColor>step {state.stepCount}</Text>
            <Text color={theme.dim}> │ </Text>
            <Text color={riskColor}>risk: {state.risk}</Text>
          </>
        )}
      </Text>
    </Box>
  )
})
