import { Box, Text } from 'ink'
import { memo } from 'react'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

export const StreamOutput = memo(function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  // Guard: if there's no text, render nothing — even if isStreaming is still true.
  // This prevents a blank-cursor frame when onTurnComplete clears streamingText
  // before setIsStreaming(false) in the same render cycle.
  if (!text) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{text}</Text>
      {isStreaming && <Text dimColor>▊</Text>}
    </Box>
  )
})
