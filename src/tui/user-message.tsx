import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="row" gap={1} paddingX={1} marginTop={1}>
      <Text color={theme.userColor} bold>{gutterGlyph('user')}</Text>
      <Text color={theme.userColor}>{content}</Text>
    </Box>
  )
})
