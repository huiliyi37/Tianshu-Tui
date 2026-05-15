import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'

export interface ApprovalRiskCardProps {
  level: 'none' | 'low' | 'medium' | 'high'
  reasons: string[]
}

function riskColor(level: string, theme: ReturnType<typeof getTheme>): string {
  if (level === 'low') return theme.warning
  if (level === 'medium') return theme.warning
  return theme.error
}

export const ApprovalRiskCard = memo(function ApprovalRiskCard({ level, reasons }: ApprovalRiskCardProps) {
  const theme = getTheme()

  if (level === 'none') return null

  return (
    <Box flexDirection="column" borderStyle="round" borderColor={riskColor(level, theme)} paddingX={1}>
      <Text bold color={riskColor(level, theme)}>⚠ Risk: {level}</Text>
      {reasons.map((r, i) => (
        <Text key={i} color={theme.dim}>• {r}</Text>
      ))}
    </Box>
  )
})
