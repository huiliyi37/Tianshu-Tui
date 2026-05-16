import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

export type CacheStatus = 'healthy' | 'degraded' | 'recovering'

export interface InterviewState {
  intent: string
  clarity: number
  round: number
  maxRounds: number
  tokensUsed: number
  confirmed: boolean
}

function tokenBar(current: number, max: number, width = 10): string {
  const filled = Math.min(Math.round((current / max) * width), width)
  return '▓'.repeat(filled) + '░'.repeat(width - filled)
}

function clarityTrend(history: number[]): string {
  if (history.length < 2) return '─'
  const prev = history[history.length - 2]!
  const curr = history[history.length - 1]!
  if (curr > prev + 0.05) return '▲'
  if (curr < prev - 0.05) return '▼'
  return '─'
}

function formatTok(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

interface StatusBarProps {
  model: string
  cacheHitRate: number
  cacheStatus?: CacheStatus
  totalCost: string
  currentTokens: number
  maxTokens: number
  contextHealth?: 'healthy' | 'warning' | 'compacting' | 'critical'
  apiSafe?: boolean
  interview?: InterviewState | null
  clarityHistory?: number[]
}

export const StatusBar = memo(function StatusBar({ model, cacheHitRate, cacheStatus = 'healthy', totalCost, currentTokens, maxTokens, contextHealth = 'healthy', apiSafe = true, interview, clarityHistory }: StatusBarProps) {
  const theme = getTheme()

  if (interview) {
    const clarityColor = interview.clarity < 0.4 ? theme.error : interview.clarity < 0.7 ? theme.warning : theme.success
    const trend = clarityHistory ? clarityTrend(clarityHistory) : '─'
    const intentDisplay = interview.intent.length > 25 ? interview.intent.slice(0, 24) + '…' : interview.intent

    return (
      <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="round" borderColor={theme.warning}>
        <Box gap={1}>
          <Text bold color={theme.warning}>⚡ interview</Text>
          <Text color={theme.dim}>R{interview.round}/{interview.maxRounds}</Text>
          <Text color={clarityColor}>
            clarity:{interview.clarity.toFixed(1)}{trend}
          </Text>
          <Text dimColor>~{formatTok(interview.tokensUsed)} tok</Text>
        </Box>
        <Box gap={1}>
          {interview.confirmed ? (
            <Text bold color={theme.success}>✓ 确认即规划</Text>
          ) : (
            <Text dimColor>intent:{intentDisplay}</Text>
          )}
        </Box>
      </Box>
    )
  }

  const hitPct = (cacheHitRate * 100).toFixed(1)
  const usagePct = ((currentTokens / maxTokens) * 100).toFixed(0)
  const bar = tokenBar(currentTokens, maxTokens)
  const usageColor = theme.contextColor(currentTokens / maxTokens)
  const cacheColor = cacheHitRate === 0 ? theme.dim : cacheHitRate >= 0.8 ? theme.success : cacheHitRate >= 0.4 ? theme.warning : theme.error
  const healthColor = contextHealth === 'critical' ? theme.error : contextHealth === 'compacting' ? theme.warning : contextHealth === 'warning' ? theme.warning : theme.success

  const statusIcon = cacheStatus === 'degraded' ? '▼' : cacheStatus === 'recovering' ? '↗' : ''
  const statusColor = cacheStatus === 'degraded' ? theme.error : cacheStatus === 'recovering' ? theme.warning : cacheColor

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="round" borderColor={theme.dim}>
      <Box gap={1}>
        <Text bold color={theme.primary}>{model}</Text>
        <Text color={statusColor}>
          cache:{statusIcon}{hitPct}%
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
