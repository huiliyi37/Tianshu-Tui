import { Box, Text } from 'ink'

const MAX_COLLAPSED_LINES = 20

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
}

export function ToolCard({ name, result, isError, isStreaming }: ToolCardProps) {
  const lines = result.split('\n')
  const isLong = lines.length > MAX_COLLAPSED_LINES
  const displayLines = isLong ? lines.slice(0, MAX_COLLAPSED_LINES) : lines
  const truncated = isLong ? lines.length - MAX_COLLAPSED_LINES : 0

  return (
    <Box
      flexDirection="column"
      paddingX={2}
      marginY={0}
      borderStyle="single"
      borderColor={isError ? 'red' : 'gray'}
    >
      <Text bold color={isError ? 'red' : 'cyan'}>
        ── {name} ──{isStreaming ? ' (running)' : ''}
      </Text>
      <Text>{displayLines.join('\n')}</Text>
      {truncated > 0 && (
        <Text dimColor>... {truncated} more lines</Text>
      )}
    </Box>
  )
}
