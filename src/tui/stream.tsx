import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  // Guard: if there's no text, render nothing — even if isStreaming is still true.
  // This prevents a blank-cursor frame when onTurnComplete clears streamingText
  // before setIsStreaming(false) in the same render cycle.
  if (!text) return null

  const textWithCursor = isStreaming ? text + '▊' : text

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{'●'}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          {isStreaming ? (
            // Simplified rendering during streaming: plain text to avoid
            // broken markdown from incomplete code blocks, links, etc.
            <Text>{textWithCursor}</Text>
          ) : (
            <Markdown text={textWithCursor} />
          )}
        </Box>
      </Box>
    </Box>
  )
})
