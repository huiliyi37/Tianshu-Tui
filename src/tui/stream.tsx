import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'

const MAX_STREAMING_LINES = 20

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  if (!text) {
    if (!isStreaming) return null
    return (
      <Box paddingX={1} marginBottom={1}>
        <Text color={theme.dim}>◌ Waiting for model…</Text>
      </Box>
    )
  }

  let displayText = text
  let omittedLines = 0
  if (isStreaming) {
    const lines = text.split('\n')
    if (lines.length > MAX_STREAMING_LINES) {
      omittedLines = lines.length - MAX_STREAMING_LINES
      displayText = lines.slice(-MAX_STREAMING_LINES).join('\n')
    }
  }

  const textWithCursor = isStreaming ? displayText + '▊' : displayText

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{'●'}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
          {isStreaming && omittedLines > 0 && (
            <Text dimColor>(… {omittedLines} earlier lines)</Text>
          )}
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {isStreaming ? (
            <Text>{textWithCursor}</Text>
          ) : (
            <Markdown text={textWithCursor} />
          )}
        </Box>
      </Box>
    </Box>
  )
})
