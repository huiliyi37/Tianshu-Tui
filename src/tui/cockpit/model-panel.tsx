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
  routingReason?: string
}

export const ModelPanel = memo(function ModelPanel({
  model, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, routingReason,
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
      <Text>
        <Text color={theme.dim}>Est. cost: </Text>
        <Text color={theme.success}>${cost.toFixed(4)}</Text>
      </Text>
    </Box>
  )
})
