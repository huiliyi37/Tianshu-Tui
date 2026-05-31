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
 * The app layer progressively flushes older content to <Static>, so
 * `text` here is always bounded (~80 lines max). No tail window needed.
 * When the turn ends the full content is in Static and this unmounts.
 */
export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  const theme = getTheme()

  if (!text) {
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
