import { Box, Text, useInput } from 'ink'
import { memo, useMemo, useState } from 'react'
import { getTheme } from './theme.js'
import { getToolFamily } from './tool-family.js'

const MAX_COLLAPSED_LINES = 15

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
  focused?: boolean
}

function compactPath(rawPath: string | undefined): string {
  if (!rawPath) return ''
  const filename = rawPath.split('/').pop() ?? rawPath
  return filename
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath, focused }: ToolCardProps) {
  const theme = getTheme()
  const [localExpanded, setLocalExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && key.tab) {
      setLocalExpanded(v => !v)
    }
  })

  const expanded = verbose || localExpanded
  const limit = expanded ? 200 : MAX_COLLAPSED_LINES
  const { displayText, truncated, totalLines } = useMemo(() => {
    const lines = result.split('\n')
    const isLong = lines.length > limit
    // Show last N lines (tail) so the output/result is visible, not the header
    const displayLines = isLong ? lines.slice(-limit) : lines
    return {
      displayText: displayLines.join('\n'),
      truncated: isLong ? lines.length - limit : 0,
      totalLines: lines.length,
    }
  }, [result, limit])

  const borderColor = isError ? theme.error : theme.toolColor(name)
  const family = getToolFamily(name)

  return (
    <Box flexDirection="column" paddingX={1} marginBottom={0}>
      <Text bold color={borderColor}>
        {family.glyph} {family.verb}{isStreaming ? ' …' : ''}
        {totalLines > MAX_COLLAPSED_LINES && !expanded && <Text dimColor> {totalLines} lines</Text>}
        {focused && totalLines > MAX_COLLAPSED_LINES ? <Text dimColor> (Tab to {localExpanded ? 'collapse' : 'expand'})</Text> : ''}
      </Text>
      <Text>{displayText}</Text>
      {truncated > 0 && (
        <Text dimColor>  {truncated} more lines{rawPath ? ` · raw: ${compactPath(rawPath)}` : ''}</Text>
      )}
      {truncated === 0 && rawPath && (
        <Text dimColor>  raw: {compactPath(rawPath)}</Text>
      )}
    </Box>
  )
})
