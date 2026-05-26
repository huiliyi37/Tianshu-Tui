import { Box, Text, useInput } from 'ink'
import { memo, useState } from 'react'
import { ToolCard } from './tool-card.js'
import { getGroupSummary } from './tool-family.js'
import { getTheme } from './theme.js'
import type { LogEntry } from './log-state.js'

interface ToolGroupProps {
  tools: LogEntry[]
  verbose: boolean
  focused?: boolean
}

export const ToolGroup = memo(function ToolGroup({ tools, verbose, focused }: ToolGroupProps) {
  const theme = getTheme()
  const summary = getGroupSummary(tools)
  const [localExpanded, setLocalExpanded] = useState(false)

  useInput((_input, key) => {
    if (focused && (key.tab || key.return)) {
      setLocalExpanded(v => !v)
    }
  })

  const expanded = verbose || localExpanded

  if (tools.length === 0) return null

  if (!expanded) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.dim}>
          {'▸'} {summary}
          {focused ? <Text italic> — Tab to expand</Text> : <Text italic> — /verbose to expand</Text>}
        </Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.dim}>{'▾'} {summary}{focused ? <Text italic> — Tab to collapse</Text> : ''}</Text>
      </Box>
      {tools.map(tool => (
        <ToolCard
          key={tool.id}
          name={tool.toolName ?? ''}
          result={tool.content}
          isError={tool.isError}
          verbose={verbose}
          rawPath={tool.rawPath}
        />
      ))}
    </Box>
  )
})
