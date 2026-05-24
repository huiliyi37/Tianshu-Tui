import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1}>
      <Box flexDirection="row" gap={1}>
        <Text color={theme.userColor} bold>{'❯'}</Text>
        <Text>{content}</Text>
      </Box>
    </Box>
  )
})
