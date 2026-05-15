import { Box, Text } from 'ink'
import { memo, useMemo } from 'react'
import { getTheme } from './theme.js'

const MAX_COLLAPSED_LINES = 8

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
}

function compactPath(rawPath: string | undefined): string {
  if (!rawPath) return ''
  const filename = rawPath.split('/').pop() ?? rawPath
  return filename
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath }: ToolCardProps) {
  const theme = getTheme()
  const limit = verbose ? 200 : MAX_COLLAPSED_LINES
  const { displayText, truncated } = useMemo(() => {
    const lines = result.split('\n')
    const isLong = lines.length > limit
    const displayLines = isLong ? lines.slice(0, limit) : lines
    return {
      displayText: displayLines.join('\n'),
      truncated: isLong ? lines.length - limit : 0,
    }
  }, [result, limit])

  const borderColor = isError ? theme.error : theme.toolColor(name)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text bold color={borderColor}>
        ── {name} ──{isStreaming ? ' …' : ''}
        {truncated > 0 && <Text dimColor> {truncated} lines hidden</Text>}
      </Text>
      <Text>{displayText}</Text>
      {truncated > 0 && (
        <Text dimColor>  use /verbose to expand{rawPath ? ` · raw: ${compactPath(rawPath)}` : ''}</Text>
      )}
      {truncated === 0 && rawPath && (
        <Text dimColor>  raw: {compactPath(rawPath)}</Text>
      )}
    </Box>
  )
})
