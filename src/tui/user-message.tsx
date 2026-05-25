import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'

interface UserMessageProps {
  content: string
}

export const UserMessage = memo(function UserMessage({ content }: UserMessageProps) {
  const theme = getTheme()
  return (
    <Box flexDirection="column" paddingX={1} marginTop={1} marginBottom={1}>
      <Box borderStyle="round" borderColor={theme.userColor} paddingX={1} flexDirection="column">
        <Box flexDirection="row" gap={1} marginBottom={1}>
          <Text color={theme.userColor} bold>{'❯'}</Text>
          <Text color={theme.userColor} bold>You</Text>
        </Box>
        <Box flexDirection="column" paddingLeft={2}>
          <Text>{content}</Text>
        </Box>
      </Box>
    </Box>
  )
})
