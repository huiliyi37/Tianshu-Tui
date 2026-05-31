import { Box, Text } from 'ink'
import { memo } from 'react'
import { Markdown } from './markdown-render.js'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

/**
 * StreamOutput — live streaming content during model generation.
 *
 * No border box, no tail window. Content flows naturally; Ink's built-in
 * output handling scrolls earlier lines off the top of the terminal.
 * When the turn ends the full content moves to <Static> and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()

  if (!text) {
    // When the stream is active but no visible text has arrived yet
    // (model thinking, between tool turns, slow network), show a subtle
    // indicator so the UI doesn't appear frozen.
    if (isStreaming) {
      return (
        <Box flexDirection="column" paddingX={1} marginBottom={1}>
          <Box flexDirection="row" gap={1}>
            <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
            <Text dimColor>◌ Waiting for model…</Text>
          </Box>
        </Box>
      )
    }
    return null
  }

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={text} />
          {isStreaming && <Text>{'▊'}</Text>}
        </Box>
      </Box>
    </Box>
  )
})
