import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { Markdown } from './markdown-render.js'

interface AssistantMessageProps {
  content: string
  thinking?: string
}

export const AssistantMessage = memo(function AssistantMessage({ content, thinking }: AssistantMessageProps) {
  const theme = getTheme()
  if (!content && !thinking) return null

  // Thinking-only turn: model produced reasoning but no text output
  if (!content && thinking) {
    const lines = thinking.split('\n')
    return (
      <Box flexDirection="column" paddingX={1} marginBottom={1}>
        <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
          <Box flexDirection="row" gap={1} marginBottom={1}>
            <Text color={theme.assistantColor} bold>{'●'}</Text>
            <Text color={theme.assistantColor} bold>Assistant</Text>
            <Text color={theme.assistantColor} italic>(thinking only)</Text>
          </Box>
          {lines.slice(0, 5).map((line, i) => (
            <Box key={i} flexDirection="row" paddingLeft={3}>
              <Text dimColor>{line}</Text>
            </Box>
          ))}
          {lines.length > 5 && (
            <Box paddingLeft={3}>
              <Text dimColor>… {lines.length - 5} more lines</Text>
            </Box>
          )}
        </Box>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{'●'}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Markdown text={content} />
        </Box>
      </Box>
    </Box>
  )
})
