import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'

export interface VerificationEntry {
  tool: string
  status: string
  summary: string
}

export interface VerificationPanelProps {
  filesRead: number
  filesModified: number
  verifications: VerificationEntry[]
}

function statusIcon(status: string): string {
  if (status === 'passed') return '✓'
  if (status === 'failed') return '✗'
  return '⚠'
}

function statusColor(status: string, theme: ReturnType<typeof getTheme>): string {
  if (status === 'passed') return theme.success
  if (status === 'failed') return theme.error
  return theme.warning
}

export const VerificationPanel = memo(function VerificationPanel({
  filesRead, filesModified, verifications,
}: VerificationPanelProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Evidence</Text>
      <Text>
        <Text color={theme.dim}>Files read: </Text>
        <Text color={theme.secondary}>{filesRead}</Text>
        <Text color={theme.dim}> │ Modified: </Text>
        <Text color={theme.secondary}>{filesModified}</Text>
      </Text>
      {verifications.map((v, i) => (
        <Text key={i}>
          <Text color={statusColor(v.status, theme)}>{statusIcon(v.status)}</Text>
          <Text color={theme.dim}> │ </Text>
          <Text>{v.tool} │ {v.summary}</Text>
        </Text>
      ))}
      {verifications.length === 0 && <Text dimColor>No verification data</Text>}
    </Box>
  )
})
