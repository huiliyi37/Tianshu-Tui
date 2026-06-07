import { useState } from 'react'
import { Box, Text, useInput } from 'ink'
import { getTheme } from './theme.js'

export interface RewindEntry {
  index: number
  content: string
}

interface RewindListProps {
  entries: RewindEntry[]
  onSelect: (entry: RewindEntry) => void
  onCancel: () => void
}

export function RewindList({ entries, onSelect, onCancel }: RewindListProps) {
  const [selectedIdx, setSelectedIdx] = useState(0)
  const theme = getTheme()

  useInput((_input, key) => {
    if (key.escape) { onCancel(); return }
    if (key.return && entries.length > 0) {
      onSelect(entries[selectedIdx]!)
      return
    }
    if (key.upArrow) { setSelectedIdx(i => Math.max(0, i - 1)); return }
    if (key.downArrow) { setSelectedIdx(i => Math.min(entries.length - 1, i + 1)); return }
  })

  if (entries.length === 0) {
    return (
      <Box paddingX={1}>
        <Text color={theme.dim}>No messages to rewind.</Text>
      </Box>
    )
  }

  return (
    <Box flexDirection="column" paddingX={1}>
      <Text color={theme.primary} bold>⏪ Rewind — select a message to undo</Text>
      <Box flexDirection="column" marginTop={1}>
        {entries.slice(0, 12).map((entry, i) => {
          const isSelected = i === selectedIdx
          const preview = entry.content.length > 60
            ? entry.content.slice(0, 59) + '…'
            : entry.content
          return (
            <Box key={entry.index}>
              <Text color={isSelected ? theme.primary : theme.dim}>{isSelected ? '>' : ' '} </Text>
              <Text color={isSelected ? theme.primary : theme.secondary} bold={isSelected}>
                {preview.replace(/\n/g, ' ')}
              </Text>
            </Box>
          )
        })}
      </Box>
      <Text color={theme.dim} dimColor> ↑↓ select · Enter confirm · Esc cancel</Text>
    </Box>
  )
}
