import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from './theme.js'
import { gutterGlyph } from './gutter.js'

interface SystemMessageProps {
  content: string
  isError?: boolean
}

export const SystemMessage = memo(function SystemMessage({ content, isError }: SystemMessageProps) {
  const theme = getTheme()
  const color = isError ? theme.error : theme.systemColor
  return (
    <Box paddingX={2}>
      <Text color={theme.dim} dimColor={!isError}>{gutterGlyph('system')} </Text>
      <Text color={!isError ? theme.dim : color} dimColor={!isError}>{content}</Text>
    </Box>
  )
})
