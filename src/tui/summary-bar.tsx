import { Box, Text } from 'ink'
import { memo, useState, useEffect } from 'react'
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
  /** How long the current phase has been running (ms) */
  phaseDurationMs?: number
  /** Current turn / max turns */
  turnCount?: number
  maxTurns?: number
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
  // Standard braille encoding: bits 0-3 = left column (dot 1-4, bottom→top), bits 4-7 = right column (dot 5-8, bottom→top)
  const leftDots = [0, 1, 2, 3]   // dot 1,2,3,4
  const rightDots = [4, 5, 6, 7]  // dot 5,6,7,8

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

const HEARTBEAT_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']

export function formatSummaryLine1(state: SummaryState, heartbeatFrame: number): string {
  const task = truncate(state.task || 'working', 30)
  const phase = state.phase
  const steps = state.totalSteps > 0 ? ` (${state.stepCount}/${state.totalSteps})` : ''
  const pct = Math.round(state.contextPct * 100)
  const elapsed = formatElapsed(state.elapsedMs)
  const spinner = HEARTBEAT_FRAMES[heartbeatFrame % HEARTBEAT_FRAMES.length]!
  const turn = state.turnCount && state.maxTurns ? ` T${state.turnCount}/${state.maxTurns}` : ''
  return `${spinner} ${task} → ${phase}${steps}${turn} │ ${contextBar(state.contextPct)} ${pct}% │ ${elapsed}`
}

export function formatSummaryLine2(state: SummaryState): string {
  if (state.phaseDurationMs !== undefined && state.phaseDurationMs > 0) {
    return `├ ${state.phase}… ${formatElapsed(state.phaseDurationMs)}`
  }
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
  const [heartbeat, setHeartbeat] = useState(0)

  // Heartbeat: cycle spinner frame every 200ms while this component mounts
  useEffect(() => {
    const id = setInterval(() => setHeartbeat(h => h + 1), 200)
    return () => clearInterval(id)
  }, [])

  const line1 = formatSummaryLine1(state, heartbeat)
  const line2 = formatSummaryLine2(state)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>
        <Text color={theme.primary}>{line1.slice(0, line1.indexOf(' '))}</Text>
        <Text bold>{line1.slice(line1.indexOf(' ') + 1, line1.indexOf(' →'))}</Text>
        <Text color={theme.dim}> → </Text>
        <Text color={theme.primary}>{state.phase}</Text>
        {state.totalSteps > 0 && <Text dimColor> ({state.stepCount}/{state.totalSteps})</Text>}
        {state.turnCount && state.maxTurns && (
          <Text dimColor> T{state.turnCount}/{state.maxTurns}</Text>
        )}
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
        {state.phaseDurationMs !== undefined && state.phaseDurationMs > 0 ? (
          <>
            <Text dimColor>{state.phase}… </Text>
            <Text color={state.phase === 'idle' ? theme.dim : theme.primary}>{formatElapsed(state.phaseDurationMs)}</Text>
          </>
        ) : state.lastAction ? (
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
