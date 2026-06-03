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

/** Build a framed folding marker: ┌─ 34 lines ─┐ */
function foldMarker(lines: number, width: number, focused: boolean, theme: ReturnType<typeof getTheme>): string {
  const label = ` ${lines} lines `
  const inner = Math.max(0, width - label.length - 2) // 2 for ┌─/─┐
  const left = '─'.repeat(Math.floor(inner / 2))
  const right = '─'.repeat(Math.ceil(inner / 2))
  return `┌${left}${label}${right}┐`
}

export const ToolCard = memo(function ToolCard({ name, result, isError, isStreaming, verbose, rawPath, focused, elapsedMs, depth = 0 }: ToolCardProps) {
  const theme = getTheme()
  const [localExpanded, setLocalExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && (key.tab || key.return)) {
      setLocalExpanded(v => !v)
    }
  })

  const expanded = verbose || localExpanded
  const expandedLimit = useViewportLines(0.6, 8)
  const family = getToolFamily(name)
  const isReader = family.family === 'read'

  const { displayText, truncated, totalLines, previewLines } = useMemo(() => {
    const lines = result.split('\n')
    const limit = expanded ? expandedLimit : MAX_COLLAPSED_LINES
    const isLong = lines.length > limit

    if (!isLong) {
      return {
        displayText: result,
        truncated: 0,
        totalLines: lines.length,
        previewLines: [] as string[],
      }
    }

    // For read_file results (read family), show file header as preview
    // so users can see file content context even when collapsed.
    // For other tools, show tail to see the result/output.
    if (isReader && !expanded) {
      const previewCount = Math.min(5, Math.floor(limit / 3))
      const tailCount = limit - previewCount
      const head = lines.slice(0, previewCount)
      const tail = lines.slice(-tailCount)
      return {
        displayText: [...head, `┄┄┄ ${lines.length - limit} lines ┄┄┄`, ...tail].join('\n'),
        truncated: lines.length - limit,
        totalLines: lines.length,
        previewLines: head,
      }
    }

    const displayLines = lines.slice(-limit)
    return {
      displayText: displayLines.join('\n'),
      truncated: lines.length - limit,
      totalLines: lines.length,
      previewLines: [] as string[],
    }
  }, [result, expanded ? expandedLimit : MAX_COLLAPSED_LINES, expanded, isReader])

  const borderColor = isError ? theme.error : theme.toolColor(name)

  // Tree connectors for nested tool call chains
  const treeLead = depth > 0 ? '  '.repeat(depth - 1) + ' ├─' : ''
  const treePad = depth > 0 ? '  '.repeat(depth) : ''

  // Collapse marker: boxed fold indicator
  const foldColor = focused ? theme.primary : theme.dim
  const foldHint = focused && truncated > 0 ? ` Enter/Tab to ${localExpanded ? 'collapse' : 'expand'}` : ''

  return (
    <Box flexDirection="column" paddingLeft={depth > 0 ? 0 : 2} paddingRight={1} marginBottom={1}>
      <Box flexDirection="row">
        {depth > 0 && <Text color={theme.dim}>{treeLead}</Text>}
        <Text bold color={borderColor}>
          {family.glyph} {family.verb}{isStreaming ? ' …' : ''}
          {isStreaming && formatToolElapsed(elapsedMs ?? 0) && (
            <Text color={theme.muted}> {formatToolElapsed(elapsedMs ?? 0)}</Text>
          )}
          {totalLines > MAX_COLLAPSED_LINES && !expanded && <Text color={theme.muted}> {totalLines} lines</Text>}
          {foldHint ? <Text color={theme.primary}> {foldHint}</Text> : null}
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
          {truncated > 0 && !expanded && (
            <Text color={foldColor} bold={!!focused}>
              {foldMarker(totalLines, 32, !!focused, theme)}
            </Text>
          )}
          {truncated === 0 && rawPath && (
            <Text color={theme.muted}>raw: {compactPath(rawPath)}</Text>
          )}
        </Box>
      </Box>
    </Box>
  )
})
