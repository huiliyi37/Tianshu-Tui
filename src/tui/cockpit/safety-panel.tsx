import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'

export interface SafetyPanelProps {
  doomLoopLevel: 'none' | 'warn' | 'blocked'
  riskLevel: 'none' | 'low' | 'medium' | 'high'
  riskReasons: string[]
  suggestedAction?: string
  recentFingerprints: number
}

function doomColor(level: string, theme: ReturnType<typeof getTheme>): string {
  if (level === 'none') return theme.success
  if (level === 'warn') return theme.warning
  return theme.error
}

function riskColor(level: string, theme: ReturnType<typeof getTheme>): string {
  if (level === 'none') return theme.dim
  if (level === 'low') return theme.success
  if (level === 'medium') return theme.warning
  return theme.error
}

export const SafetyPanel = memo(function SafetyPanel({
  doomLoopLevel, riskLevel, riskReasons, suggestedAction, recentFingerprints,
}: SafetyPanelProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Safety</Text>
      <Text>
        <Text color={theme.muted}>Doom loop: </Text>
        <Text color={doomColor(doomLoopLevel, theme)} bold={doomLoopLevel !== 'none'}>
          {doomLoopLevel}
        </Text>
      </Text>
      <Text>
        <Text color={theme.muted}>Risk: </Text>
        <Text color={riskColor(riskLevel, theme)} bold={riskLevel === 'high'}>
          {riskLevel}
        </Text>
      </Text>
      {riskReasons.map((r, i) => (
        <Text key={i} color={theme.warning}>• {r}</Text>
      ))}
      {suggestedAction && riskLevel !== 'none' && riskLevel !== 'low' && (
        <Text color={theme.dim} italic>{suggestedAction}</Text>
      )}
      <Text>
        <Text color={theme.muted}>Fingerprint diversity: </Text>
        <Text color={theme.secondary}>{recentFingerprints} unique</Text>
      </Text>
    </Box>
  )
})
