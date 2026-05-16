import { Box, Text, useInput } from 'ink'
import { memo, useState } from 'react'
import { ToolCard } from './tool-card.js'
import { getGroupSummary } from './tool-family.js'
import { getTheme } from './theme.js'
import type { LogEntry } from './log-state.js'

interface ToolGroupProps {
  tools: LogEntry[]
  verbose: boolean
}

export const ToolGroup = memo(function ToolGroup({ tools, verbose: initialVerbose }: ToolGroupProps) {
  const theme = getTheme()
  const [expanded, setExpanded] = useState(initialVerbose)
  const summary = getGroupSummary(tools)

  useInput((_input, key) => {
    if (key.return) {
      setExpanded(v => !v)
    }
  })

  if (tools.length === 0) return null

  if (!expanded) {
    return (
      <Box paddingX={1} flexDirection="column">
        <Text color={theme.dim}>{'▸'} {summary} <Text italic>— Enter to expand</Text></Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column">
      <Box paddingX={1}>
        <Text color={theme.dim}>{'▾'} {summary} <Text italic>— Enter to collapse</Text></Text>
      </Box>
      {tools.map(tool => (
        <ToolCard
          key={tool.id}
          name={tool.toolName ?? ''}
          result={tool.content}
          isError={tool.isError}
          verbose={initialVerbose}
          rawPath={tool.rawPath}
        />
      ))}
    </Box>
  )
})
