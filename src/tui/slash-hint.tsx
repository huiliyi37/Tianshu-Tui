import { Box, Text } from 'ink'
import { useMemo } from 'react'
import { getTheme } from './theme.js'
import { type PaletteCommand, filterCommands } from './command-palette.js'

interface SlashHintProps {
  input: string
  selectedIdx: number
  commands: PaletteCommand[]
}

/** Maximum number of items to render before the "more…" footer. */
export const SLASH_HINT_MAX_VISIBLE = 6

export function SlashHint({ input, selectedIdx, commands }: SlashHintProps) {
  const theme = getTheme()
  const query = input.slice(1) // strip leading /
  const filtered = useMemo(() => filterCommands(commands, query), [commands, query])

  if (filtered.length === 0) return null

  const visible = filtered.slice(0, SLASH_HINT_MAX_VISIBLE)
  const overflow = filtered.length - visible.length

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={theme.primary}
      paddingX={1}
      marginX={1}
    >
      <Box marginBottom={1}>
        <Text color={theme.dim}>◇ Command Palette</Text>
      </Box>
      {visible.map((cmd, i) => {
        const selected = i === selectedIdx
        return (
          <Box key={cmd.name}>
            <Text color={selected ? theme.primary : theme.dim}>
              {selected ? '❯ ' : '  '}
            </Text>
            <Text bold={selected} color={selected ? theme.primary : theme.secondary}>
              {highlightMatch(cmd.name, query)}
            </Text>
            <Text color={theme.muted}> — {cmd.description}</Text>
          </Box>
        )
      })}
      {overflow > 0 && (
        <Box marginTop={1}>
          <Text color={theme.dim}>… {overflow} more</Text>
        </Box>
      )}
    </Box>
  )
}

function highlightMatch(name: string, query: string): string {
  if (!query) return name
  return name
}
