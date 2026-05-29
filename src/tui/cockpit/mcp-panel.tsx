import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'

export interface McpServerEntry {
  serverId: string
  status: string
  toolCount: number
  lastErrorClass?: string
}

export interface McpPanelProps {
  servers: McpServerEntry[]
  totalTools: number
  connectedServers: number
}

function statusIcon(status: string): string {
  if (status === 'connected') return '●'
  if (status === 'connecting') return '◐'
  return '✗'
}

function statusColor(status: string, theme: ReturnType<typeof getTheme>): string {
  if (status === 'connected') return theme.success
  if (status === 'connecting') return theme.warning
  return theme.error
}

export const McpPanel = memo(function McpPanel({ servers, totalTools, connectedServers }: McpPanelProps) {
  const theme = getTheme()

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>MCP</Text>
      <Text>
        <Text color={theme.muted}>Servers: </Text>
        <Text color={theme.secondary}>{connectedServers}/{servers.length}</Text>
        <Text color={theme.muted}> │ Tools: </Text>
        <Text color={theme.secondary}>{totalTools}</Text>
      </Text>
      {servers.map(s => (
        <Text key={s.serverId}>
          <Text color={statusColor(s.status, theme)}>{statusIcon(s.status)}</Text>
          <Text color={theme.dim}> │ </Text>
          <Text>{s.serverId}</Text>
          <Text color={theme.dim}> │ {s.toolCount} tools</Text>
          {s.lastErrorClass && <Text color={theme.warning}> · {s.lastErrorClass}</Text>}
        </Text>
      ))}
      {servers.length === 0 && <Text color={theme.muted}>No MCP servers configured</Text>}
    </Box>
  )
})
