import { Box, Text } from 'ink'
import { memo } from 'react'

const MAX_COLLAPSED_LINES = 12

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath }: ToolCardProps) {
  const limit = verbose ? 200 : MAX_COLLAPSED_LINES
  const lines = result.split('\n')
  const isLong = lines.length > limit
  const displayLines = isLong ? lines.slice(0, limit) : lines
  const truncated = isLong ? lines.length - limit : 0

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
        <Text dimColor>... {truncated} more lines{rawPath ? ` [raw: ${rawPath}]` : ''}</Text>
      )}
      {truncated === 0 && rawPath && (
        <Text dimColor>[raw: {rawPath}]</Text>
      )}
    </Box>
  )
})
