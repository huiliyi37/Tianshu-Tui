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
  // While the agent is active but no visible text has arrived yet, keep a
  // lightweight status on screen. Without this, long provider/tool/post-turn
  // silent windows look like a frozen TUI.
  if (!text) {
    if (!isStreaming) return null
    return (
      <Box paddingX={1} marginBottom={1}>
        <Text color={theme.dim}>◌ Waiting for model…</Text>
      </Box>
    )
  }

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
