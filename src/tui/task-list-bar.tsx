import React from 'react'
import { Box, Text } from 'ink'
import type { TaskListItem } from '../agent/session-state.js'

const STATUS_GLYPH: Record<TaskListItem['status'], string> = {
  pending: '◻',
  in_progress: '◼',
  completed: '✓',
  blocked: '⊗',
}

const STATUS_COLOR: Record<TaskListItem['status'], string> = {
  pending: 'grey',
  in_progress: 'cyan',
  completed: 'green',
  blocked: 'red',
}

const MAX_VISIBLE_ITEMS = 5

export function TaskListBar({ items }: { items: readonly TaskListItem[] }) {
  if (items.length === 0) return null

  const visible = items.slice(0, MAX_VISIBLE_ITEMS)
  const overflow = items.length > MAX_VISIBLE_ITEMS ? ` +${items.length - MAX_VISIBLE_ITEMS}` : ''

  // 窄终端：每项一行；宽终端：水平拼接
  const cols = process.stdout.columns ?? 80
  const narrow = cols < 70

  if (narrow) {
    return (
      <Box flexDirection="column" paddingX={1} borderStyle="single" borderColor="grey">
        <Text dimColor>▸ Tasks</Text>
        {visible.map(item => (
          <Box key={item.id}>
            <Text color={STATUS_COLOR[item.status]}>{STATUS_GLYPH[item.status]}</Text>
            <Text dimColor> {item.id} </Text>
            <Text>{item.content.slice(0, 50)}{item.content.length > 50 ? '…' : ''}</Text>
          </Box>
        ))}
        {overflow ? <Text dimColor>{overflow} more…</Text> : null}
      </Box>
    )
  }

  // 宽终端：单行水平拼接
  const segments = visible.map(item =>
    `${STATUS_GLYPH[item.status]} ${item.id} ${item.content.slice(0, 30)}${item.content.length > 30 ? '…' : ''}`
  )
  const line = segments.join(' │ ')

  return (
    <Box paddingX={1} borderStyle="single" borderColor="grey">
      <Text>
        <Text dimColor>▸ </Text>
        <Text>{line}</Text>
        {overflow ? <Text dimColor>{overflow} more</Text> : null}
      </Text>
    </Box>
  )
}
