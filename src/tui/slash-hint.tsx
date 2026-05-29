import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { getTheme } from './theme.js'
import { type PaletteCommand, filterCommands } from './command-palette.js'

interface SlashHintProps {
  input: string
  selectedIdx: number
  commands: PaletteCommand[]
}

export function SlashHint({ input, selectedIdx, commands }: SlashHintProps) {
  const theme = getTheme()
  const query = input.slice(1) // strip leading /
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])

  if (filtered.length === 0) return null

  return (
    <Box flexDirection="column" paddingX={2}>
      {filtered.slice(0, 6).map((cmd, i) => (
        <Box key={cmd.name}>
          <Text color={i === selectedIdx ? 'green' : undefined}>
            {i === selectedIdx ? '❯ ' : '  '}
            <Text bold={i === selectedIdx} color={i === selectedIdx ? 'green' : 'cyan'}>
              {highlightMatch(cmd.name, query)}
            </Text>
            <Text color={theme.muted}> — {cmd.description}</Text>
          </Text>
        </Box>
      ))}
    </Box>
  )
}

function highlightMatch(name: string, query: string): string {
  if (!query) return name
  return name
}
