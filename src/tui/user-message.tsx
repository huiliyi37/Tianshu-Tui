import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'
import { useTerminalSize } from './use-terminal-size.js'
import { horizontalRule } from './separator.js'

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const theme = getTheme()
  const { columns } = useTerminalSize()
  return (
    <Box flexDirection="column" paddingX={1} marginTop={2} marginBottom={0}>
      <Text color={theme.dim}>{horizontalRule(columns, 'thin')}</Text>
      <Box flexDirection="row" gap={1} marginTop={1}>
        <Text color={theme.userColor} bold>{gutterGlyph('user')}</Text>
        <Box flexDirection="column" flexGrow={1}>
          <Text color={theme.userColor} dimColor>You</Text>
          <Text color={theme.userColor}>{content}</Text>
        </Box>
      </Box>
    </Box>
  )
})
