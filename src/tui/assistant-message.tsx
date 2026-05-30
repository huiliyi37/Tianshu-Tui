import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { Markdown } from './markdown-render.js'
import { gutterGlyph } from './gutter.js'

interface AssistantMessageProps {
  content: string
}

/**
 * Assistant content message — rendered in <Static> list (print-and-forget to
 * terminal scrollback). Full content is rendered without line-count truncation;
 * long replies stay readable via native terminal scrolling.
 */
export const AssistantMessage = memo(function AssistantMessage({ content }: AssistantMessageProps) {
  const theme = getTheme()

  if (!content) return null

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.assistantColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
          <Text color={theme.assistantColor} bold>Assistant</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Markdown text={content} />
        </Box>
      </Box>
    </Box>
  )
})
