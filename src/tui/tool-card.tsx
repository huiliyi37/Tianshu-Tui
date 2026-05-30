import { Box, Text, useInput } from 'ink'
import { memo, useMemo, useState } from 'react'
import { getTheme } from './theme.js'
import { getToolFamily } from './tool-family.js'
import { Markdown } from './markdown-render.js'
import { formatToolElapsed } from './tool-elapsed.js'
import { useTerminalSize } from './use-terminal-size.js'

const MAX_COLLAPSED_LINES = 15

/** Chrome lines that must always remain visible (GlanceBar + InputBar + margins) */
const DYNAMIC_CHROME = 6

/** Maximum lines a collapsed ToolCard can use — adapts to terminal size */
function cappedCollapsedLines(termRows: number): number {
  // On small terminals, cap at ~half the terminal height to prevent overflow
  const maxForTerminal = Math.max(3, Math.floor(termRows / 2) - 2)
  return Math.min(MAX_COLLAPSED_LINES, maxForTerminal)
}

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
  focused?: boolean
  elapsedMs?: number
}

function compactPath(rawPath: string | undefined): string {
  if (!rawPath) return ''
  const filename = rawPath.split('/').pop() ?? rawPath
  return filename
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath, focused, elapsedMs }: ToolCardProps) {
  const theme = getTheme()
  const { rows } = useTerminalSize()
  const [localExpanded, setLocalExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && key.tab) {
      setLocalExpanded(v => !v)
    }
  })

  const expanded = verbose || localExpanded
  const collapsedLimit = cappedCollapsedLines(rows)
  // Expanded cap: allow more detail but never exceed terminal height minus chrome
  const expandedLimit = Math.min(200, Math.max(collapsedLimit, rows - DYNAMIC_CHROME))
  const limit = expanded ? expandedLimit : collapsedLimit
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
        {isStreaming && formatToolElapsed(elapsedMs ?? 0) && (
          <Text color={theme.muted}> {formatToolElapsed(elapsedMs ?? 0)}</Text>
        )}
        {totalLines > MAX_COLLAPSED_LINES && !expanded && <Text color={theme.muted}> {totalLines} lines</Text>}
        {focused && totalLines > MAX_COLLAPSED_LINES ? <Text color={theme.muted}> (Tab to {localExpanded ? 'collapse' : 'expand'})</Text> : ''}
      </Text>
      <Markdown text={displayText} />
      {truncated > 0 && (
        <Text color={theme.muted}>  {truncated} more lines{rawPath ? ` · raw: ${compactPath(rawPath)}` : ''}</Text>
      )}
      {truncated === 0 && rawPath && (
        <Text color={theme.muted}>  raw: {compactPath(rawPath)}</Text>
      )}
    </Box>
  )
})
