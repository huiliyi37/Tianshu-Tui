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
 * terminal scrollback). No border box: a bordered box welds the whole reply into
 * one indivisible render unit the terminal can't paginate, so long replies stack
 * and overflow. claude-code style — gutter glyph + plain text rows that flow into
 * native terminal scrollback.
 */
export const AssistantMessage = memo(function AssistantMessage({ content }: AssistantMessageProps) {
  const theme = getTheme()

  if (!content) return null

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.assistantColor} bold>{gutterGlyph('assistant')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Markdown text={content} />
        </Box>
      </Box>
    </Box>
  )
})
