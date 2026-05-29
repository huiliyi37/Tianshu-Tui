import { Box, Text } from 'ink'
import { memo } from 'react'
import { getTheme } from '../theme.js'

export interface TraceEvent {
  id: string
  turn: number
  kind: string
  name: string
  status: string
  durationMs?: number
  summary?: string
}

export interface TracePanelProps {
  events: TraceEvent[]
}

const MAX_EVENTS = 20

function statusColor(status: string, theme: ReturnType<typeof getTheme>): string {
  if (status === 'passed' || status === 'done') return theme.success
  if (status === 'failed') return theme.error
  if (status === 'running') return theme.warning
  return theme.error // blocked
}

export const TracePanel = memo(function TracePanel({ events }: TracePanelProps) {
  const theme = getTheme()
  const visible = events.slice(-MAX_EVENTS)

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text bold color={theme.primary}>Trace ({events.length} events)</Text>
      {visible.map(e => (
        <Text key={e.id}>
          <Text color={theme.muted}>turn {e.turn} │ </Text>
          <Text color={theme.secondary}>{e.kind} │ </Text>
          <Text>{e.name} │ </Text>
          <Text color={statusColor(e.status, theme)}>{e.status}</Text>
          {e.durationMs != null && <Text color={theme.dim}> │ {e.durationMs}ms</Text>}
        </Text>
      ))}
      {events.length === 0 && <Text color={theme.muted}>No trace events</Text>}
    </Box>
  )
})
