import { Box, Text, useInput } from 'ink'
import { memo, useMemo, useState } from 'react'
import { getTheme } from './theme.js'
import { getToolFamily } from './tool-family.js'
import { Markdown } from './markdown-render.js'
import { formatToolElapsed } from './tool-elapsed.js'
import { useViewportLines } from './viewport.js'

const MAX_COLLAPSED_LINES = 15

interface ToolCardProps {
  name: string
  result: string
  isError?: boolean
  isStreaming?: boolean
  verbose?: boolean
  rawPath?: string
  focused?: boolean
  elapsedMs?: number
  /** Nesting depth for tool call chain tree connectors */
  depth?: number
}

function compactPath(rawPath: string | undefined): string {
  if (!rawPath) return ''
  const filename = rawPath.split('/').pop() ?? rawPath
  return filename
}

/** Map file extension to language hint for syntax highlighting */
function extToLang(rawPath: string | undefined): string | undefined {
  if (!rawPath) return undefined
  const ext = rawPath.split('.').pop()?.toLowerCase()
  switch (ext) {
    case 'ts': case 'tsx': case 'js': case 'jsx': case 'mjs': case 'mts': return 'typescript'
    case 'py': return 'python'
    case 'go': return 'go'
    case 'rs': return 'rust'
    case 'sh': case 'bash': case 'zsh': return 'bash'
    case 'java': return 'java'
    case 'cpp': case 'cc': case 'cxx': case 'c': case 'h': case 'hpp': return 'cpp'
    case 'sql': return 'sql'
    case 'rb': return 'ruby'
    case 'php': return 'php'
    case 'swift': return 'swift'
    case 'kt': case 'kts': return 'kotlin'
    default: return undefined
  }
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath, focused, elapsedMs, depth = 0 }: ToolCardProps) {
  const theme = getTheme()
  const [localExpanded, setLocalExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && key.tab) {
      setLocalExpanded(v => !v)
    }
  })

  const expanded = verbose || localExpanded
  const expandedLimit = useViewportLines(0.6, 8)
  const limit = expanded ? expandedLimit : MAX_COLLAPSED_LINES
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

  // Tree connectors for nested tool call chains
  const treeLead = depth > 0 ? '  '.repeat(depth - 1) + ' ├─' : ''
  const treePad = depth > 0 ? '  '.repeat(depth) : ''

  return (
    <Box flexDirection="column" paddingLeft={depth > 0 ? 0 : 2} paddingRight={1} marginBottom={0}>
      <Box flexDirection="row">
        {depth > 0 && <Text color={theme.dim}>{treeLead}</Text>}
        <Text bold color={borderColor}>
          {family.glyph} {family.verb}{isStreaming ? ' …' : ''}
          {isStreaming && formatToolElapsed(elapsedMs ?? 0) && (
            <Text color={theme.muted}> {formatToolElapsed(elapsedMs ?? 0)}</Text>
          )}
          {totalLines > MAX_COLLAPSED_LINES && !expanded && <Text color={theme.muted}> {totalLines} lines</Text>}
          {focused && totalLines > MAX_COLLAPSED_LINES ? <Text color={theme.muted}> (Tab to {localExpanded ? 'collapse' : 'expand'})</Text> : ''}
        </Text>
      </Box>
      <Box flexDirection="row">
        {depth > 0 && <Text color={theme.dim}>{treePad}│</Text>}
        <Box
          borderStyle="single"
          borderColor={isError ? theme.error : theme.dim}
          borderLeft={true}
          borderRight={false}
          borderTop={false}
          borderBottom={false}
          paddingLeft={1}
          flexDirection="column"
          flexGrow={1}
        >
          <Markdown text={displayText} language={extToLang(rawPath)} />
          {truncated > 0 && (
            <Text color={theme.muted}>{truncated} more lines{rawPath ? ` · raw: ${compactPath(rawPath)}` : ''}</Text>
          )}
          {truncated === 0 && rawPath && (
            <Text color={theme.muted}>raw: {compactPath(rawPath)}</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
})
