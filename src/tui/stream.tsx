import { Box, Text } from 'ink'

interface StreamOutputProps {
  text: string
  isStreaming: boolean
}

export function StreamOutput({ text, isStreaming }: StreamOutputProps) {
  if (!text && !isStreaming) return null

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text>{text}</Text>
      {isStreaming && <Text dimColor>▊</Text>}
    </Box>
  )
}
