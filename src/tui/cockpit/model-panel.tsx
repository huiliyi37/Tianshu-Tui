import { Box, Text } from 'ink'
import { memo } from 'react'
import type { PhysarumShadowStats } from '../../repo/physarum-shadow-stats.js'
import { getTheme } from '../theme.js'
import { contextBar } from '../format-utils.js'

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
  physarumShadow?: PhysarumShadowStats
  cacheDiagnostic?: string | null
  reasoningEffort?: string
}

const EFFORT_BAR: Record<string, string> = {
  off: '○',
  low: '◔',
  medium: '◑',
  high: '◕',
  max: '●',
}

const EFFORT_COLOR: Record<string, string> = {
  off: 'gray',
  low: 'blue',
  medium: 'cyan',
  high: 'yellow',
  max: 'magenta',
}

export const ModelPanel = memo(function ModelPanel({
  model, cacheHitRate, inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, cost, routingReason,
  perTurnHitRate = null, recentTurnHitRate = null, prewarmHits = 0, prewarmMisses = 0, prewarmHitRate = 0,
  physarumShadow, cacheDiagnostic = null, reasoningEffort = 'medium',
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
          <Text color={theme.muted}>Selected for: </Text>
          <Text color={theme.secondary}>{routingReason}</Text>
        </Text>
      )}
      <Text>
        <Text color={theme.muted}>Effort:  </Text>
        <Text color={EFFORT_COLOR[reasoningEffort] ?? 'white'}>{EFFORT_BAR[reasoningEffort] ?? '◑'} {reasoningEffort}</Text>
      </Text>
      <Text>
        <Text color={theme.muted}>Cache: </Text>
        <Text color={theme.contextColor(1 - cacheHitRate)}>{contextBar(cacheHitRate, 8)}</Text>
        <Text color={theme.dim}> {Math.round(cacheHitRate * 100)}%</Text>
      </Text>
      <Text>
        <Text color={theme.muted}>Tokens ─ in: </Text>
        <Text>{(inputTokens / 1000).toFixed(1)}k</Text>
        <Text color={theme.muted}> out: </Text>
        <Text>{(outputTokens / 1000).toFixed(1)}k</Text>
      </Text>
      <Text>
        <Text color={theme.muted}>Cache  ─ read: </Text>
        <Text>{(cacheReadTokens / 1000).toFixed(1)}k</Text>
        <Text color={theme.muted}> write: </Text>
        <Text>{(cacheWriteTokens / 1000).toFixed(1)}k</Text>
      </Text>
      {perTurnHitRate !== null && (
        <Text>
          <Text color={theme.muted}>Turn cache: </Text>
          <Text color={theme.contextColor(1 - perTurnHitRate)}>{Math.round(perTurnHitRate * 100)}%</Text>
          {recentTurnHitRate !== null && (
            <>
              <Text color={theme.muted}> │ Recent 3: </Text>
              <Text color={theme.contextColor(1 - recentTurnHitRate)}>{Math.round(recentTurnHitRate * 100)}%</Text>
            </>
          )}
          <Text color={theme.muted}> │ Prewarm: </Text>
          <Text>{prewarmHits}/{prewarmHits + prewarmMisses}</Text>
          <Text color={theme.dim}> ({Math.round(prewarmHitRate * 100)}%)</Text>
        </Text>
      )}
      {physarumShadow && (
        <Text>
          <Text color={theme.muted}>Shadow next-step: </Text>
          <Text>hit@1 {Math.round(physarumShadow.hitAt1 * 100)}%</Text>
          <Text color={theme.muted}> │ hit@3 </Text>
          <Text>{Math.round(physarumShadow.hitAt3 * 100)}%</Text>
          <Text color={theme.dim}> ({physarumShadow.total} obs, miss {physarumShadow.miss})</Text>
        </Text>
      )}
      {perTurnHitRate !== null && perTurnHitRate < 0.4 && (
        <Text color={theme.warning}>▼ Cache degraded — compaction or prefix drift may have reset cache</Text>
      )}
      {cacheDiagnostic && <Text color={theme.warning}>{cacheDiagnostic}</Text>}
      <Text>
        <Text color={theme.muted}>Est. cost: </Text>
        <Text color={theme.success}>${cost.toFixed(4)}</Text>
      </Text>
    </Box>
  )
})
