import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface StatusBarProps {
  model: string
  cacheHitRate: number
  totalCost: string
  currentTokens: number
  maxTokens: number
  contextHealth?: 'healthy' | 'warning' | 'compacting' | 'critical'
  apiSafe?: boolean
}

function tokenBar(current: number, max: number, width = 10): string {
  const filled = Math.min(Math.round((current / max) * width), width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

export const StatusBar = memo(function StatusBar({ model, cacheHitRate, totalCost, currentTokens, maxTokens, contextHealth = 'healthy', apiSafe = true }: StatusBarProps) {
  const theme = getTheme()
  const hitPct = (cacheHitRate * 100).toFixed(1)
  const usagePct = ((currentTokens / maxTokens) * 100).toFixed(0)
  const bar = tokenBar(currentTokens, maxTokens)
  const usageColor = theme.contextColor(currentTokens / maxTokens)
  const cacheColor = cacheHitRate === 0 ? theme.dim : cacheHitRate >= 0.8 ? theme.success : cacheHitRate >= 0.4 ? theme.warning : theme.error
  const healthColor = contextHealth === 'critical' ? theme.error : contextHealth === 'compacting' ? theme.warning : contextHealth === 'warning' ? theme.warning : theme.success

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="round" borderColor={theme.dim}>
      <Box gap={1}>
        <Text bold color={theme.primary}>{model}</Text>
        <Text color={cacheColor}>
          cache:{hitPct}%
        </Text>
        <Text color={healthColor}>
          ctx:{contextHealth}
        </Text>
        <Text color={apiSafe ? theme.success : theme.error}>
          rounds:{apiSafe ? 'safe' : '!'}
        </Text>
        <Text dimColor>
          ¥{totalCost}
        </Text>
      </Box>
      <Box gap={1}>
        <Text color={usageColor}>{bar}</Text>
        <Text dimColor>
          {currentTokens.toLocaleString()}/{maxTokens.toLocaleString()} ({usagePct}%)
        </Text>
      </Box>
    </Box>
  )
})
