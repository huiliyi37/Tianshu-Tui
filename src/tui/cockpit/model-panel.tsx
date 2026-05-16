import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'
import { contextBar } from '../summary-bar.js'

export interface ModelPanelProps {
  model: string
  cacheHitRate: number
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  cost: number
  routingReason?: string | null
  perTurnHitRate?: number | null
  recentTurnHitRate?: number | null
  prewarmHits?: number
  prewarmMisses?: number
  prewarmHitRate?: number
  cacheDiagnostic?: string | null
}

export const ModelPanel = memo(function ModelPanel({
  model, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, routingReason,
  perTurnHitRate = null, recentTurnHitRate = null, prewarmHits = 0, prewarmMisses = 0, prewarmHitRate = 0, cacheDiagnostic = null,
}: ModelPanelProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Model</Text>
      <Text>
        <Text color={theme.secondary}>{model}</Text>
      </Text>
      {routingReason && (
        <Text>
          <Text color={theme.dim}>Selected for: </Text>
          <Text color={theme.secondary}>{routingReason}</Text>
        </Text>
      )}
      <Text>
        <Text color={theme.dim}>Cache: </Text>
        <Text color={theme.contextColor(1 - cacheHitRate)}>{contextBar(cacheHitRate, 8)}</Text>
        <Text color={theme.dim}> {Math.round(cacheHitRate * 100)}%</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>Tokens ─ in: </Text>
        <Text>{(inputTokens / 1000).toFixed(1)}k</Text>
        <Text color={theme.dim}> out: </Text>
        <Text>{(outputTokens / 1000).toFixed(1)}k</Text>
      </Text>
      <Text>
        <Text color={theme.dim}>Cache  ─ read: </Text>
        <Text>{(cacheReadTokens / 1000).toFixed(1)}k</Text>
        <Text color={theme.dim}> write: </Text>
        <Text>{(cacheWriteTokens / 1000).toFixed(1)}k</Text>
      </Text>
      {perTurnHitRate !== null && (
        <Text>
          <Text color={theme.dim}>Turn cache: </Text>
          <Text color={theme.contextColor(1 - perTurnHitRate)}>{Math.round(perTurnHitRate * 100)}%</Text>
          {recentTurnHitRate !== null && (
            <>
              <Text color={theme.dim}> │ Recent 3: </Text>
              <Text color={theme.contextColor(1 - recentTurnHitRate)}>{Math.round(recentTurnHitRate * 100)}%</Text>
            </>
          )}
          <Text color={theme.dim}> │ Prewarm: </Text>
          <Text>{prewarmHits}/{prewarmHits + prewarmMisses}</Text>
          <Text color={theme.dim}> ({Math.round(prewarmHitRate * 100)}%)</Text>
        </Text>
      )}
      {perTurnHitRate !== null && perTurnHitRate < 0.4 && (
        <Text color={theme.warning}>▼ Cache degraded — compaction or prefix drift may have reset cache</Text>
      )}
      {cacheDiagnostic && <Text color={theme.warning}>{cacheDiagnostic}</Text>}
      <Text>
        <Text color={theme.dim}>Est. cost: </Text>
        <Text color={theme.success}>${cost.toFixed(4)}</Text>
      </Text>
    </Box>
  )
})
