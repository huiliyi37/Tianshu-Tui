import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface AssistantMessageProps {
  content: string
  thinking?: string
}

export const AssistantMessage = memo(function AssistantMessage({ content, thinking }: AssistantMessageProps) {
  const theme = getTheme()
  if (!content && !thinking) return null

  // Thinking-only turn: model produced reasoning but no text output
  if (!content && thinking) {
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Text color={theme.assistantColor} bold>{'●'} </Text>
          <Text dimColor italic>(thinking only — no text output)</Text>
        </Box>
      </Box>
    )
  }

  const lines = content.split('\n')

  return (
    <Box flexDirection="column" paddingX={1}>
      <Box flexDirection="row">
        <Text color={theme.assistantColor} bold>{'●'} </Text>
        <Text>{lines[0]}</Text>
      </Box>
      {lines.slice(1).map((line, i) => (
        <Box key={i} flexDirection="row">
          <Text dimColor>{'⎿'} </Text>
          <Text>{line}</Text>
        </Box>
      ))}
    </Box>
  )
})
