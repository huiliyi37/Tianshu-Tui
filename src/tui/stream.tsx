import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { useViewportLines } from './viewport.js'

/**
 * StreamOutput — live streaming content during model generation.
 *
 * Height limit is viewport-aware: at most 60% of terminal rows.
 * When streaming ends and content moves to <Static>, this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()
  const maxLines = useViewportLines(0.6, 8)

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
    if (lines.length > maxLines) {
      omittedLines = lines.length - maxLines
      displayText = lines.slice(-maxLines).join('\n')
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

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}
