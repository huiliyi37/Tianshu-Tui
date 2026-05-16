import { Box, Text } from 'ink'
import { memo } from 'react'
import { ToolCard } from './tool-card.js'
import { getGroupSummary } from './tool-family.js'
import { getTheme } from './theme.js'
import type { LogEntry } from './log-state.js'

interface ToolGroupProps {
  tools: LogEntry[]
  verbose: boolean
}

export const ToolGroup = memo(function ToolGroup({ tools, verbose }: ToolGroupProps) {
  const theme = getTheme()
  const summary = getGroupSummary(tools)

  if (tools.length === 0) return null

  if (!verbose) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.dim}>{'▸'} {summary} <Text italic>— /verbose to expand</Text></Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.dim}>{'▾'} {summary}</Text>
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
