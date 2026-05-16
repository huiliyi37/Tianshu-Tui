import { Box, Text } from 'ink'
import { memo } from 'react'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  if (!text && !isStreaming) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text wrap="wrap">{text}</Text>
      {isStreaming && <Text dimColor>▊</Text>}
    </Box>
  )
})
