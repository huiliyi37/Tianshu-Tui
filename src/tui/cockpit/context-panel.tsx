import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'
import { contextBar } from '../summary-bar.js'

export interface CompactEvent {
  turn: number
  tier: number
  beforeTokens: number
  afterTokens: number
}

export interface ContextPanelProps {
  estimatedTokens: number
  maxTokens: number
  rounds: number
  compactionState: string
  brokenRounds: number
  compactEvents: CompactEvent[]
}

function compactionColor(state: string, theme: ReturnType<typeof getTheme>): string {
  if (state === 'healthy') return theme.success
  if (state === 'warning') return theme.warning
  return theme.error // critical
}

export const ContextPanel = memo(function ContextPanel({
  estimatedTokens, maxTokens, rounds, compactionState, brokenRounds, compactEvents,
}: ContextPanelProps) {
  const theme = getTheme()
  const pct = maxTokens > 0 ? estimatedTokens / maxTokens : 0

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Context</Text>
      <Text>
        <Text color={theme.contextColor(pct)}>{contextBar(pct, 8)}</Text>
        <Text color={theme.dim}> {Math.round(estimatedTokens / 1000)}k/{Math.round(maxTokens / 1000)}k ({Math.round(pct * 100)}%)</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>Rounds: </Text>
        <Text>{rounds}</Text>
        {brokenRounds > 0 && <Text color={theme.warning}> ({brokenRounds} broken)</Text>}
      </Text>
      <Text>
        <Text color={theme.dim}>Compaction: </Text>
        <Text color={compactionColor(compactionState, theme)}>{compactionState}</Text>
      </Text>
      {compactEvents.slice(-3).map((e, i) => (
        <Text key={i} color={theme.dim}>
          t{e.turn} tier{e.tier}: {Math.round(e.beforeTokens / 1000)}k→{Math.round(e.afterTokens / 1000)}k
        </Text>
      ))}
    </Box>
  )
})
