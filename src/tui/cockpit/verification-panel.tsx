import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'
import type { DeliveryVerificationStatus } from '../../agent/evidence.js'

export interface VerificationEntry {
  tool: string
  status: string
  summary: string
}

export interface VerificationPanelProps {
  filesRead: number
  filesModified: number
  verifications: VerificationEntry[]
  deliveryStatus?: DeliveryVerificationStatus
  impactedFiles?: number
  impactedTests?: number
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

function deliveryColor(status: DeliveryVerificationStatus, theme: ReturnType<typeof getTheme>): string {
  if (status === 'verified') return theme.success
  if (status === 'failed') return theme.error
  if (status === 'blocked') return theme.warning
  return theme.dim
}

export const VerificationPanel = memo(function VerificationPanel({
  filesRead, filesModified, verifications, deliveryStatus, impactedFiles, impactedTests,
}: VerificationPanelProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Evidence</Text>
      <Text>
        <Text color={theme.muted}>Files read: </Text>
        <Text color={theme.secondary}>{filesRead}</Text>
        <Text color={theme.muted}> │ Modified: </Text>
        <Text color={theme.secondary}>{filesModified}</Text>
      </Text>
      {deliveryStatus && (
        <Text>
          <Text color={theme.muted}>Delivery: </Text>
          <Text color={deliveryColor(deliveryStatus, theme)} bold>{deliveryStatus}</Text>
        </Text>
      )}
      {(impactedFiles ?? 0) > 0 && (
        <Text>
          <Text color={theme.muted}>Impacts: </Text>
          <Text color={theme.secondary}>{impactedFiles} files</Text>
          {(impactedTests ?? 0) > 0 && (
            <>
              <Text color={theme.dim}> │ </Text>
              <Text color={theme.warning}>{impactedTests} tests to run</Text>
            </>
          )}
        </Text>
      )}
      {verifications.map((v, i) => (
        <Text key={i}>
          <Text color={statusColor(v.status, theme)}>{statusIcon(v.status)}</Text>
          <Text color={theme.dim}> │ </Text>
          <Text>{v.tool} │ {v.summary}</Text>
        </Text>
      ))}
      {verifications.length === 0 && !deliveryStatus && <Text color={theme.muted}>No verification data</Text>}
    </Box>
  )
})
