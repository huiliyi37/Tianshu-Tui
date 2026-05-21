import { Box, Text, useStdout } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

export type CacheStatus = 'healthy' | 'degraded' | 'recovering' | 'stale'

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
  reasoningEffort?: string
  verification?: { verified: number; total: number }
}

export function verificationColor(summary: { verified: number; total: number }, theme: ReturnType<typeof getTheme>): string {
  if (summary.total === 0 || summary.verified === summary.total) return theme.success
  if (summary.verified === 0) return theme.error
  return theme.warning
}

export const StatusBar = memo(function StatusBar({ model, cacheHitRate, cacheStatus = 'healthy', totalCost, currentTokens, maxTokens, contextHealth = 'healthy', apiSafe = true, interview, clarityHistory, reasoningEffort, verification }: StatusBarProps) {
  const theme = getTheme()
  const { stdout } = useStdout()
  const cols = stdout?.columns ?? 80

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
  const usageColor = theme.contextColor(currentTokens / maxTokens)
  const cacheColor = cacheHitRate === 0 ? theme.dim : cacheHitRate >= 0.8 ? theme.success : cacheHitRate >= 0.4 ? theme.warning : theme.error
  const healthColor = contextHealth === 'critical' ? theme.error : contextHealth === 'compacting' ? theme.warning : contextHealth === 'warning' ? theme.warning : theme.success

  const statusIcon = cacheStatus === 'degraded' ? '▼' : cacheStatus === 'recovering' ? '↗' : cacheStatus === 'stale' ? '…' : ''
  const statusColor = cacheStatus === 'degraded' ? theme.error : cacheStatus === 'recovering' || cacheStatus === 'stale' ? theme.warning : cacheColor

  const compact = cols < 70
  const narrow = cols < 90

  const shortModel = model.length > 8 && narrow ? model.slice(0, 7) + '…' : model
  const barW = compact ? 6 : narrow ? 8 : 10
  const shortBar = tokenBar(currentTokens, maxTokens, barW)

  return (
    <Box flexDirection="row" justifyContent="space-between" paddingX={1} borderStyle="round" borderColor={theme.dim}>
      <Box gap={1}>
        <Text bold color={theme.primary}>{shortModel}</Text>
        {reasoningEffort && reasoningEffort !== 'off' && (
          <Text color={reasoningEffort === 'max' ? theme.error : reasoningEffort === 'high' ? theme.warning : theme.dim}>
            {reasoningEffort}
          </Text>
        )}
        <Text color={statusColor}>
          cache:{statusIcon}{hitPct}%
        </Text>
        {!compact && (
          <Text color={healthColor}>
            ctx:{contextHealth}
          </Text>
        )}
        {!narrow && (
          <Text color={apiSafe ? theme.success : theme.error}>
            rounds:{apiSafe ? 'safe' : '!'}
          </Text>
        )}
        <Text dimColor>
          ¥{totalCost}
        </Text>
        {verification && verification.total > 0 && (
          <Text color={verificationColor(verification, theme)}>
            ✓{verification.verified}/{verification.total} files verified
          </Text>
        )}
      </Box>
      <Box gap={1}>
        <Text color={usageColor}>{shortBar}</Text>
        <Text dimColor>
          {usagePct}%
        </Text>
      </Box>
    </Box>
  )
})
